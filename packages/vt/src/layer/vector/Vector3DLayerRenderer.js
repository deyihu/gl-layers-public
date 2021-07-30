import * as maptalks from 'maptalks';
import { createREGL, reshader, mat4, vec3 } from '@maptalks/gl';
import { convertToFeature, ID_PROP } from './util/build_geometry';
import { IconRequestor, GlyphRequestor, PointPack, LinePack, StyledPoint, VectorPack, StyledVector } from '@maptalks/vector-packer';
import { extend, isNumber } from '../../common/Util';
import { MARKER_SYMBOL, TEXT_SYMBOL, LINE_SYMBOL } from './util/symbols';
import { KEY_IDX } from '../../common/Constant';
import Promise from '../../common/Promise';
import Vector3DLayer from './Vector3DLayer';
import { isFunctionDefinition } from '@maptalks/function-type';

// const SYMBOL_SIMPLE_PROPS = {
//     textFill: 1,
//     textSize: 1,
//     textOpacity: 1,
//     // textHaloRadius: 1,
//     textHaloFill: 1,
//     textHaloOpacity: 1,
//     textPitchAlignment: 1,
//     textRotationAlignment: 1,
//     textDx: 1, //TODO
//     textDy: 1, //TODO

//     // markerWidth: 1,
//     // markerHeight: 1,
//     markerOpacity: 1,
//     markerPitchAlignment: 1,
//     markerRotationAlignment: 1,
//     markerDx: 1, //TODO
//     markerDy: 1, //TODO

//     lineColor: 1,
//     lineWidth: 1,
//     lineOpacity: 1,
//     lineDx: 1, //TODO
//     lineDy: 1, //TODO
//     lineGapWidth: 1, //TODO
//     lineDasharray: null,

//     polygonFill: 1,
//     polygonOpacity: 1
// };

let meshUID = 1;
const prefix = '_symbol_';
const KEY_IDX_NAME = (KEY_IDX + '').trim();
let EMPTY_POSITION = new Float32Array(1);

class Vector3DLayerRenderer extends maptalks.renderer.CanvasRenderer {
    constructor(...args) {
        super(...args);
        this.features = {};
        this._geometries = {};
        this._counter = 1;
        this._allFeatures = {};
        this._markerFeatures = {};
        this._textFeatures = {};
        this._lineFeatures = {};
        this._dirtyAll = true;
        this._kidGen = { id: 0 };
        this._markerSymbol = extend({}, MARKER_SYMBOL, TEXT_SYMBOL);
        this._dirtyTargetsInCurrentFrame = {};
    }

    hasNoAARendering() {
        return true;
    }

    //always redraw when map is interacting
    needToRedraw() {
        const redraw = super.needToRedraw();
        if (!redraw) {
            return this.painter && this.painter.needToRedraw() ||
                this._markerPainter && this._markerPainter.needToRedraw() ||
                this._linePainter && this._linePainter.needToRedraw();
        }
        return redraw;
    }

    draw(timestamp, parentContext) {
        const layer = this.layer;
        this.prepareCanvas();
        this._zScale = this._getCentiMeterScale(this.getMap().getGLZoom()); // scale to convert meter to gl point
        if (this._dirtyAll) {
            this.buildMesh();
            this._buildMarkerMesh();
            this._buildLineMesh();
            this._dirtyAll = false;
            this._dirtyGeo = false;
            // this._dirtySymbol = false;
        } else if (this._dirtyGeo) {
            const atlas = this.atlas;
            const markerAtlas = this._markerAtlas;
            const lineAtlas = this._lineAtlas;
            delete this.atlas;
            delete this._markerAtlas;
            delete this._lineAtlas;
            this.buildMesh(atlas);
            this._buildMarkerMesh(markerAtlas);
            this._buildLineMesh(lineAtlas);
            this._dirtyGeo = false;
            // this._dirtySymbol = false;
        }
        if (this._showHideUpdated) {
            this._updateMeshVisible();
            this._showHideUpdated = false;
        }/* else if (this._dirtySymbol) {
            this.updateSymbol();
            this._dirtySymbol = false;
        }*/
        if (!this.meshes && !this._markerMeshes && !this._lineMeshes) {
            this.completeRender();
            return;
        }

        this._updateDirtyTargets();

        if (layer.options['collision']) {
            layer.clearCollisionIndex();
        }
        this._frameTime = timestamp;
        this._parentContext = parentContext || {};
        const context = this._preparePaintContext();
        let polygonOffset = 0;
        if (this.painter && this.meshes) {
            this.painter.startFrame(context);
            this.painter.addMesh(this.meshes);
            this.painter.prepareRender(context);
            context.polygonOffsetIndex = polygonOffset++;
            this.painter.render(context);
        }

        if (this._lineMeshes) {
            this._linePainter.startFrame(context);
            this._linePainter.addMesh(this._lineMeshes);
            this._linePainter.prepareRender(context);
            context.polygonOffsetIndex = polygonOffset++;
            this._linePainter.render(context);
        }

        if (this._markerMeshes) {
            this._markerPainter.startFrame(context);
            this._markerPainter.addMesh(this._markerMeshes);
            this._markerPainter.prepareRender(context);
            if (layer.options.collision) {
                this._markerPainter.updateCollision(context);
            }

            this._markerPainter.render(context);
        }

        this.completeRender();
        this.layer.fire('canvasisdirty');
    }

    supportRenderMode(mode) {
        return mode === 'noAa';
    }

    isForeground() {
        return true;
    }

    _preparePaintContext() {
        const context = {
            regl: this.regl,
            layer: this.layer,
            symbol: this._layerSymbol,
            gl: this.gl,
            sceneConfig: this.layer.options.sceneConfig,
            pluginIndex: 0,
            cameraPosition: this.getMap().cameraPosition,
            timestamp: this.getFrameTimestamp()
        };
        if (this._parentContext) {
            extend(context, this._parentContext);
        }
        return context;
    }

    drawOnInteracting(event, timestamp, parentContext) {
        this.draw(timestamp, parentContext);
    }

    getFrameTimestamp() {
        return this._frameTime;
    }

    // updateSymbol() {
    //     this.painter.updateSymbol(this.painterSymbol, this.painterSymbol);
    // }

    _getFeaturesToRender() {
        const features = [];
        const center = [0, 0, 0, 0];
        //为了解决UglifyJS对 feature[KEY_IDX] 不正确的mangle
        // const KEY_IDX_NAME = (KEY_IDX + '').trim();
        // let count = 0;
        for (const p in this.features) {
            if (this.features.hasOwnProperty(p)) {
                const feature = this.features[p];
                if (Array.isArray(feature)) {
                    // count = count++;
                    for (let i = 0; i < feature.length; i++) {
                        const fea = feature[i];
                        if (!fea.visible) {
                            this._showHideUpdated = true;
                        }
                        this._addCoordsToCenter(fea.geometry, center);
                        // fea[KEY_IDX_NAME] = count++;
                        features.push(fea);
                    }
                } else {
                    if (!feature.visible) {
                        this._showHideUpdated = true;
                    }
                    this._addCoordsToCenter(feature.geometry, center);
                    // feature[KEY_IDX_NAME] = count++;
                    features.push(feature);
                }

            }
        }

        if (!features.length) {
            if (this.meshes && this.painter) {
                this.painter.deleteMesh(this.meshes);
                delete this.meshes;
            }
            if (this._markerMeshes) {
                this._markerPainter.deleteMesh(this.meshes);
                delete this._markerMeshes;
            }
            if (this._lineMeshes) {
                this._linePainter.deleteMesh(this.meshes);
                delete this._lineMeshes;
            }
        }
        if (center[3]) {
            center[0] /= center[3];
            center[1] /= center[3];
        }
        return {
            features,
            center
        };
    }

    buildMesh(/*atlas*/) {
        // if (!this.painter) {
        //     return;
        // }
        // //TODO 更新symbol的优化
        // //1. 如果只影响texture，则只重新生成texture
        // //2. 如果不影响Geometry，则直接调用painter.updateSymbol
        // //3. Geometry和Texture全都受影响时，则全部重新生成
        // const { features, center } = this._getFeaturesToRender();
        // if (!features.length) {
        //     return;
        // }

        // this.createMesh(this.painter, this.PackClass, features, atlas, center).then(m => {
        //     if (this.meshes) {
        //         this.painter.deleteMesh(this.meshes);
        //     }
        //     const { mesh, atlas } = m;
        //     this.meshes = mesh;
        //     this.atlas = atlas;
        //     this.setToRedraw();
        // });
    }

    createVectorPacks(painter, PackClass, symbol, features, atlas, center) {
        if (!painter || !features || !features.length) {
            return Promise.resolve(null);
        }
        const options = {
            zoom: this.getMap().getZoom(),
            EXTENT: Infinity,
            requestor: this.requestor,
            atlas,
            center,
            positionType: Float32Array
        };

        const pack = new PackClass(features, symbol, options);
        return pack.load();
    }

    createMesh(painter, PackClass, symbol, features, atlas, center) {
        const v0 = [], v1 = [];
        return this.createVectorPacks(painter, PackClass, symbol, features, atlas, center).then(packData => {
            if (!packData) {
                return null;
            }
            const geometry = painter.prepareGeometry(packData.data, features.map(feature => { return { feature }; }));
            this._fillCommonProps(geometry.geometry);
            const posMatrix = mat4.identity([]);
            //TODO 计算zScale时，zoom可能和tileInfo.z不同
            mat4.translate(posMatrix, posMatrix, vec3.set(v1, center[0], center[1], 0));
            mat4.scale(posMatrix, posMatrix, vec3.set(v0, 1, 1, this._zScale));
            // mat4.scale(posMatrix, posMatrix, vec3.set(v0, glScale, glScale, this._zScale));
            // const transform = mat4.translate([], mat4.identity([]), center);

            // mat4.translate(posMatrix, posMatrix, vec3.set(v0, tilePos.x * glScale, tilePos.y * glScale, 0));
            const mesh = painter.createMesh(geometry, posMatrix, { tilePoint: [center[0], center[1]] });
            mesh.setUniform('level', 0);
            const defines = mesh.defines;
            //不开启ENABLE_TILE_STENCIL的话，frag中会用tileExtent剪切图形，会造成图形绘制不出
            defines['ENABLE_TILE_STENCIL'] = 1;
            mesh.setDefines(defines);
            mesh.properties.meshKey = this.layer.getId();
            return {
                mesh,
                atlas: {
                    iconAtlas: packData.data.iconAtlas
                }
            };
        });
    }

    _addCoordsToCenter(geometry, center) {
        for (let i = 0; i < geometry.length; i++) {
            if (isNumber(geometry[i][0])) {
                center[0] += geometry[i][0];
                center[1] += geometry[i][1];
                center[3] += 1;
            } else {
                for (let ii = 0; ii < geometry[i].length; ii++) {
                    if (isNumber(geometry[i][ii][0])) {
                        center[0] += geometry[i][ii][0];
                        center[1] += geometry[i][ii][1];
                        center[3] += 1;
                    } else {
                        for (let iii = 0; iii < geometry[i][ii].length; iii++) {
                            center[0] += geometry[i][ii][iii][0];
                            center[1] += geometry[i][ii][iii][1];
                            center[3] += 1;
                        }
                    }
                }
            }
        }
    }

    _fillCommonProps(geometry) {
        const map = this.getMap();
        const props = geometry.properties;
        Object.defineProperty(props, 'tileResolution', {
            enumerable: true,
            get: function () {
                return map.getResolution(map.getGLZoom());
            }
        });
        props.tileRatio = 1;
        props.z = map.getGLZoom();
        props.tileExtent = 1;
    }

    _isEnableWorkAround(key) {
        if (key === 'win-intel-gpu-crash') {
            return this.layer.options['workarounds']['win-intel-gpu-crash'] && isWinIntelGPU(this.gl);
        }
        return false;
    }

    prepareRequestors() {
        if (this._iconRequestor) {
            return;
        }
        const layer = this.layer;
        this._iconRequestor = new IconRequestor({ iconErrorUrl: layer.options['iconErrorUrl'] });
        const useCharBackBuffer = !this._isEnableWorkAround('win-intel-gpu-crash');
        this._glyphRequestor = new GlyphRequestor(fn => {
            layer.getMap().getRenderer().callInNextFrame(fn);
        }, layer.options['glyphSdfLimitPerFrame'], useCharBackBuffer);
        this.requestor = this._fetchPattern.bind(this);
        this._markerRequestor = this._fetchIconGlyphs.bind(this);
    }

    _fetchPattern(icons, glyphs, cb) {
        const dataBuffers = [];
        this._iconRequestor.getIcons(icons, (err, data) => {
            if (err) {
                throw err;
            }
            if (data.buffers) {
                dataBuffers.push(...data.buffers);
            }
            cb(null, { icons: data.icons }, dataBuffers);
        });
    }

    _fetchIconGlyphs(icons, glyphs, cb) {
        //error, data, buffers
        this._glyphRequestor.getGlyphs(glyphs, (err, glyphData) => {
            if (err) {
                throw err;
            }
            const dataBuffers = glyphData.buffers || [];
            this._iconRequestor.getIcons(icons, (err, data) => {
                if (err) {
                    throw err;
                }
                if (data.buffers && data.buffers.length) {
                    dataBuffers.push(...data.buffers);
                }
                cb(null, { icons: data.icons, glyphs: glyphData.glyphs }, dataBuffers);
            });
        });
        //error, data, buffers

    }

    _buildMarkerMesh(atlas) {
        const markerUIDs = Object.keys(this._markerFeatures);
        const textUIDs = Object.keys(this._textFeatures);
        if (!markerUIDs.length && !textUIDs.length) {
            if (this._markerMeshes) {
                this._markerPainter.deleteMesh(this._markerMeshes);
                delete this._markerMeshes;
            }
            return;
        }

        const  { features, center } = this._getFeaturesToRender();


        const markerFeatures = [];
        const textFeatures = [];
        for (let i = 0; i < features.length; i++) {
            const kid = features[i][KEY_IDX_NAME];
            if (this._markerFeatures[kid]) {
                markerFeatures.push(features[i]);
            }
            if (this._textFeatures[kid]) {
                textFeatures.push(features[i]);
            }
        }
        if (!markerFeatures.length && !textFeatures.length) {
            if (this._markerMeshes) {
                this._markerPainter.deleteMesh(this._markerMeshes);
                delete this._markerMeshes;
            }
            return;
        }
        const showHideUpdated = this._showHideUpdated;
        this._markerCenter = center;
        const pointPacks = this._createPointPacks(markerFeatures, textFeatures, atlas, center);
        this._markerAtlas = {};
        const v0 = [], v1 = [];
        Promise.all(pointPacks).then(packData => {
            if (this._markerMeshes) {
                this._markerPainter.deleteMesh(this._markerMeshes);
                delete this._markerMeshes;
            }
            if (!packData || !packData.length) {
                this.setToRedraw();
                return;
            }
            const geometries = this._markerPainter.prepareGeometry(packData.map(d => d && d.data), this._allFeatures);

            for (let i = 0; i < geometries.length; i++) {
                this._fillCommonProps(geometries[i].geometry, packData[i] && packData[i].data);
            }
            const iconAtlas = packData[0] && packData[0].data.iconAtlas;
            const glyphAtlas = packData[0] && packData[0].data.glyphAtlas || packData[1] && packData[1].data.glyphAtlas;

            if (iconAtlas) {
                this._markerAtlas.iconAtlas = iconAtlas;
            }
            if (glyphAtlas) {
                this._markerAtlas.glyphAtlas = glyphAtlas;
            }

            const posMatrix = mat4.identity([]);
            //TODO 计算zScale时，zoom可能和tileInfo.z不同
            mat4.translate(posMatrix, posMatrix, vec3.set(v1, center[0], center[1], 0));
            mat4.scale(posMatrix, posMatrix, vec3.set(v0, 1, 1, this._zScale));
            // mat4.scale(posMatrix, posMatrix, vec3.set(v0, glScale, glScale, this._zScale))
            let meshes = this._markerPainter.createMesh(geometries, posMatrix);
            if (meshes && !Array.isArray(meshes)) {
                meshes = [meshes];
            }
            for (let i = 0; i < meshes.length; i++) {
                meshes[i].geometry.properties.originElements = meshes[i].geometry.properties.elements.slice();
                meshes[i].setUniform('level', 0);
                meshes[i].material.set('flipY', 1);
                meshes[i].properties.meshKey = meshUID++;
            }
            this._markerMeshes = meshes;
            if (showHideUpdated) {
                this._showHideUpdated = true;
            }
            this.setToRedraw();
        });
    }

    _updateMeshVisible() {
        if (this._markerMeshes) {
            this._updateVisElements(this._markerMeshes[0], this._markerFeatures);
            this._updateVisElements(this._markerMeshes[1], this._textFeatures);
        }
        if (this._lineMeshes) {
            for (let i = 0; i < this._lineMeshes.length; i++) {
                this._updateVisElements(this._lineMeshes[i], this._lineFeatures);
            }
        }
        if (this.meshes) {
            for (let i = 0; i < this.meshes.length; i++) {
                this._updateVisElements(this.meshes[i], this._allFeatures);
            }
        }
    }

    _updateVisElements(mesh, features) {
        if (!mesh) {
            return;
        }
        const { aPickingId, originElements } = mesh.geometry.properties;
        const newElements = [];
        for (let j = 0; j < originElements.length; j++) {
            const kid = aPickingId[originElements[j]];
            if (features[kid] && features[kid].feature.visible) {
                newElements.push(originElements[j]);
            }
        }
        //这里需要替换elements，是因为iconPainter和textPainter中可能会计算collision，需要读取elements
        const arr = mesh.geometry.properties.elements = new originElements.constructor(newElements);
        mesh.geometry.setElements(arr);
    }

    _createPointPacks(markerFeatures, textFeatures, atlas, center) {
        const markerOptions = {
            zoom: this.getMap().getZoom(),
            EXTENT: Infinity,
            requestor: this._markerRequestor,
            atlas,
            center,
            positionType: Float32Array,
            altitudeProperty: 'altitude',
            defaultAltitude: 0
        };
        const textOptions = extend({}, markerOptions);
        markerOptions.allowEmptyPack = 1;

        const symbols = PointPack.splitPointSymbol(this._markerSymbol);
        return symbols.map((symbol, idx) => {
            return new PointPack(idx === 0 ? markerFeatures : textFeatures, symbol, idx === 0 ? markerOptions : textOptions).load();
        });
    }

    updateMesh() {}

    _updateMarkerMesh(marker) {
        const symbols = marker['_getInternalSymbol']();
        const options = { zoom: this.getMap().getZoom() };
        const uid = this._convertGeo(marker);
        if (!this._markerMeshes) {
            return false;
        }
        let feature = this.features[uid];
        if (!Array.isArray(feature)) {
            feature = [feature];
        }
        const markerFeatures = [];
        const textFeatures = [];
        // 检查是否atlas需要重新创建，如果需要，则重新创建整个mesh
        for (let i = 0; i < feature.length; i++) {
            const fea = feature[i];
            if (!fea) {
                continue;
            }
            const symbol = Array.isArray(symbols) ? symbols[i] : symbols;
            const fnTypes = VectorPack.genFnTypes(symbol);
            const styledPoint = new StyledPoint(feature, symbol, fnTypes, options);
            const iconGlyph = styledPoint.getIconAndGlyph();
            if (!this._markerAtlas || !PointPack.isAtlasLoaded(iconGlyph, this._markerAtlas)) {
                this._markRebuild();
                this.setToRedraw();
                return false;
            }
        }

        const kid = feature[0][KEY_IDX_NAME];
        if (this._markerFeatures[kid]) {
            markerFeatures.push(...feature);
        }
        if (this._textFeatures[kid]) {
            textFeatures.push(...feature);
        }


        const pointPacks = this._createPointPacks(markerFeatures, textFeatures, this._markerAtlas, this._markerCenter);
        Promise.all(pointPacks).then(packData => {
            for (let i = 0; i < packData.length; i++) {
                if (!packData[i]) {
                    continue;
                }
                const mesh = Array.isArray(this._markerMeshes) ? this._markerMeshes[i] : this._markerMeshes;
                const pickingData = mesh.geometry.properties.aPickingId;
                const startIndex = pickingData.indexOf(kid);
                const count = packData[i].data.featureIds.length;
                for (const p in packData[i].data.data) {
                    const data = packData[i].data.data[p];
                    mesh.geometry.updateSubData(p, data, startIndex * data.length / count * data.BYTES_PER_ELEMENT);
                }
            }
            this.setToRedraw();

        });
        return true;
    }

    _updateLineMesh(target) {
        if (!this._lineMeshes) {
            return false;
        }
        return this._updateMesh(target, this._lineMeshes, this._lineAtlas, this._lineCenter, this._linePainter, LinePack, LINE_SYMBOL, this._groupLineFeas);
    }

    _updateMesh(target, meshes, atlas, center, painter, PackClass, globalSymbol, groupFeaturesFn) {
        if (!atlas) {
            this._markRebuild();
            this.setToRedraw();
            return false;
        }
        const symbols = target['_getInternalSymbol']();
        const options = { zoom: this.getMap().getZoom() };
        const uid = this._convertGeo(target);
        let feature = this.features[uid];
        if (!Array.isArray(feature)) {
            feature = [feature];
        }
        const features = [];
        // 检查是否atlas需要重新创建，如果需要，则重新创建整个mesh
        for (let i = 0; i < feature.length; i++) {
            const fea = feature[i];
            if (!fea) {
                continue;
            }
            const symbol = Array.isArray(symbols) ? symbols[i] : symbols;
            const fnTypes = VectorPack.genFnTypes(symbol);
            const styledVector = new StyledVector(feature, symbol, fnTypes, options);
            const res = PackClass === LinePack ? styledVector.getLineResource() : styledVector.getPolygonResource();
            if (!VectorPack.isAtlasLoaded(res, atlas[i])) {
                this._markRebuild();
                this.setToRedraw();
                return false;
            }
            features.push(fea);
        }

        const featureGroups = groupFeaturesFn.call(this, features);

        const symbol = extend({}, globalSymbol);
        const packs = featureGroups.map(feas =>
            this.createVectorPacks(painter, PackClass, symbol, feas, atlas[0], center)
        );

        const kid = feature[0][KEY_IDX_NAME];
        Promise.all(packs).then(packData => {
            for (let i = 0; i < packData.length; i++) {
                let mesh;
                if (Array.isArray(meshes)) {
                    for (let j = 0; j < meshes.length; j++) {
                        if (meshes[j].feaGroupIndex === i) {
                            mesh = meshes[j];
                            break;
                        }
                    }
                } else {
                    mesh = meshes;
                }
                if (!mesh) {
                    continue;
                }
                const pickingData = mesh.geometry.properties.aPickingId;
                const startIndex = pickingData.indexOf(kid);
                let walker = startIndex + 1;
                while (pickingData[walker] === kid) {
                    walker++;
                }
                if (!packData[i]) {
                    const length = walker - startIndex;
                    if (EMPTY_POSITION.length !== length * 3) {
                        EMPTY_POSITION = new Float32Array(length * 3);
                        EMPTY_POSITION.fill(-Infinity, 0);
                    }
                    mesh.geometry.updateSubData(mesh.geometry.desc.positionAttribute, EMPTY_POSITION, startIndex * 3 * Float32Array.BYTES_PER_ELEMENT);
                } else {
                    const count = packData[i].data.featureIds.length;
                    const datas = packData[i].data.data;
                    for (const p in datas) {
                        if (datas.hasOwnProperty(p)) {
                            const data = datas[p];
                            mesh.geometry.updateSubData(p, data, startIndex * data.length / count * data.BYTES_PER_ELEMENT);
                            // mesh.geometry.updateData(p, data);
                        }
                    }
                }
                this.setToRedraw();
            }
        });
        return true;
    }

    _buildLineMesh(atlas) {
        const lineUIDs = Object.keys(this._lineFeatures);
        if (!lineUIDs.length) {
            if (this._lineMeshes) {
                this._linePainter.deleteMesh(this._lineMeshes);
                delete this._lineMeshes;
            }
            return;
        }
        const { features, center } = this._getFeaturesToRender();
        if (!features.length) {
            return;
        }
        const showHideUpdated = this._showHideUpdated;
        this._lineCenter = center;

        const featureGroups = this._groupLineFeas(features);

        const symbol = extend({}, LINE_SYMBOL);
        const promises = featureGroups.map((feas, i) =>
            this.createMesh(this._linePainter, LinePack, symbol, feas, atlas && atlas[i], center)
        );

        Promise.all(promises).then(mm => {
            if (this._lineMeshes) {
                this._linePainter.deleteMesh(this._lineMeshes);
            }
            const meshes = [];
            const atlas = [];
            for (let i = 0; i < mm.length; i++) {
                if (mm[i]) {
                    mm[i].mesh.feaGroupIndex = i;
                    meshes.push(mm[i].mesh);
                    mm[i].mesh.geometry.properties.originElements = mm[i].mesh.geometry.properties.elements.slice();
                    atlas[i] = mm[i].atlas;
                }
            }
            this._lineMeshes = meshes;
            this._lineAtlas = atlas;
            if (showHideUpdated) {
                this._showHideUpdated = showHideUpdated;
            }
            this.setToRedraw();
        });
    }

    _groupLineFeas(features) {
        //因为有虚线和没有虚线的line绘制逻辑不同，需要分开创建mesh
        const feas = [];
        const patternFeas = [];
        const dashFeas = [];
        for (let i = 0; i < features.length; i++) {
            const f = features[i];
            const dash = f.properties && f.properties[prefix + 'lineDasharray'];
            if (dash && dashLength(dash)) {
                dashFeas.push(f);
            } else if (f.properties && f.properties[prefix + 'linePatternFile']) {
                patternFeas.push(f);
            } else {
                feas.push(f);
            }
        }
        return [patternFeas, dashFeas, feas];
    }

    _markRebuildGeometry() {
        this._dirtyGeo = true;
    }

    _markRebuild() {
        this._dirtyAll = true;
    }


    _convertGeometries(geometries) {
        const layerId = this.layer.getId();
        for (let i = 0; i < geometries.length; i++) {
            const geo = geometries[i];
            let hit = false;
            for (let ii = 0; ii < this.GeometryTypes.length; ii++) {
                if (geo instanceof this.GeometryTypes[ii]) {
                    hit = true;
                    break;
                }
            }
            if (!hit) {
                throw new Error(`${geo.getJSONType()} can't be added to ${this.layer.getJSONType()}(id:${layerId}).`);
            }

            this._convertGeo(geo);
        }
    }

    _convertGeo(geo) {
        if (!geo[ID_PROP]) {
            geo[ID_PROP] = this._counter++;
        }
        const uid = geo[ID_PROP];
        if (this.features[uid]) {
            this._removeFeatures(uid);
        }
        this.features[uid] = convertToFeature(geo, this._kidGen, this.features[uid]);
        const feas = this.features[uid];
        this._refreshFeatures(feas);
        this.features[uid][ID_PROP] = uid;
        this._geometries[uid] = geo;
        return uid;
    }

    _refreshFeatures(feas) {
        if (!feas) {
            return;
        }

        const kid = Array.isArray(feas) ? feas[0][KEY_IDX_NAME] : feas[KEY_IDX_NAME];
        this._allFeatures[kid] = feas;
        if (Array.isArray(feas)) {
            // 但geometry多symbol时，markerFeatures中只会保存最后一个feature的属性
            for (let j = 0; j < feas.length; j++) {
                // kid 是painter内部用来
                const kid = feas[j][KEY_IDX_NAME];
                // 采用 { feature } 结构，是为了和VT图层中 { feature, symbol } 统一
                const feaObj = { feature: feas[j] };
                if (hasMarkerSymbol(feas[j])) {
                    this._markerFeatures[kid] = feaObj;
                    // this._markerFeatures[kid].push(feaObj);
                }
                if (hasTextSymbol(feas[j])) {
                    this._textFeatures[kid] = feaObj;
                    // this._textFeatures[kid].push(feaObj);
                }
                if (hasLineSymbol(feas[j])) {
                    this._lineFeatures[kid] = feaObj;
                    // this._lineFeatures[uid].push(feaObj);
                }
            }
        } else {
            const feaObj = { feature: feas };
            const kid = feas[KEY_IDX_NAME];
            if (hasMarkerSymbol(feas)) {
                this._markerFeatures[kid] = feaObj;
            }
            if (hasTextSymbol(feas)) {
                this._textFeatures[kid] = feaObj;
            }
            if (hasLineSymbol(feas)) {
                this._lineFeatures[kid] = feaObj;
            }
            this._allFeatures[kid] = feaObj;
        }
    }

    _removeFeatures(uid) {
        const features = this.features[uid];
        if (Array.isArray(features)) {
            for (let i = 0; i < features.length; i++) {
                const id = features[i][KEY_IDX_NAME];
                delete this._allFeatures[id];
                delete this._markerFeatures[id];
                delete this._textFeatures[id];
                delete this._lineFeatures[id];
            }
        } else {
            const id = features[KEY_IDX_NAME];
            delete this._allFeatures[id];
            delete this._markerFeatures[id];
            delete this._textFeatures[id];
            delete this._lineFeatures[id];
        }
    }

    pick(x, y, options) {
        const hits = [];
        const painters = [this.painter, this._markerPainter, this._linePainter];
        painters.forEach(painter => {
            if (!painter) {
                return;
            }
            const picked = painter.pick(x, y, options.tolerance);
            if (picked && picked.data && picked.data.feature) {
                const feature = picked.data.feature;
                hits.push(this._geometries[feature[ID_PROP]]);
            }
        });
        return hits;
    }

    _getFeaKeyId(geo) {
        const uid = geo[ID_PROP];
        const features = this.features[uid];
        return Array.isArray(features) ? features[0][KEY_IDX_NAME] : features[KEY_IDX_NAME];
    }

    _updateDirtyTargets() {
        let updated = false;
        for (const p in this._dirtyTargetsInCurrentFrame) {
            const target = this._dirtyTargetsInCurrentFrame[p];
            const kid = this._getFeaKeyId(target);

            if (this._markerFeatures[kid] || this._textFeatures[kid]) {
                const partial = this._updateMarkerMesh(target);
                updated = updated || partial;
            }
            if (this._lineFeatures[kid]) {
                const partial = this._updateLineMesh(target);
                updated = updated || partial;
            }
            const partial = this.updateMesh(target);
            updated = updated || partial;
        }
        this._dirtyTargetsInCurrentFrame = {};
        if (updated) {
            redraw(this);
            this.layer.fire('partialupdate');
        }
    }

    _convertAndRebuild(geo) {
        this._convertGeo(geo);
        this._markRebuild();
        redraw(this);
    }

    onGeometryAdd(geometries) {
        if (!geometries || !geometries.length) {
            return;
        }
        this._convertGeometries(geometries);
        this._markRebuild();
        redraw(this);
    }

    onGeometryRemove(geometries) {
        if (!geometries || !geometries.length) {
            return;
        }
        for (let i = 0; i < geometries.length; i++) {
            const geo = geometries[i];
            const uid = geo[ID_PROP];
            if (uid !== undefined) {
                delete this._geometries[uid];
                this._removeFeatures(uid);
                delete this.features[uid];
            }
        }
        this._markRebuild();
        redraw(this);
    }

    onGeometrySymbolChange(e) {
        // const { properties } = e;
        //TODO 判断properties中哪些只需要调用painter.updateSymbol
        // 如果有，则更新 this.painterSymbol 上的相应属性，以触发painter中的属性更新
        const geo = e.target['_getParent']() || e.target;
        const id = geo[ID_PROP];
        const symbol = geo['_getInternalSymbol']();
        const feas = this.features[id];
        this._convertGeo(geo);
        if (feas) {
            if (!compareSymbolCount(symbol, feas)) {
                this._convertAndRebuild(geo);
                return;
            }
            if (Array.isArray(symbol)) {
                for (let i = 0; i < symbol.length; i++) {
                    const s = symbol[i];
                    if (!compareSymbolProp(s, feas[i])) {
                        this._convertAndRebuild(geo);
                        return;
                    }
                }
            } else if (!compareSymbolProp(symbol, feas)) {
                this._convertAndRebuild(geo);
                return;
            }
        } else {
            this._convertAndRebuild(geo);
            return;
        }
        this.onGeometryPositionChange(e);
    }

    onGeometryShapeChange(e) {
        const target = e.target['_getParent']() || e.target;
        const geojson = convertToFeature(target, { id: 0 });
        const coordJSON = geojson.geometry;
        const uid = target[ID_PROP];
        const features = this.features[uid];
        const currentFea =  Array.isArray(features) ? features[0] : features;
        if (compareCoordSize(coordJSON, currentFea.geometry)) {
            this.onGeometryPositionChange(e);
            return;
        }
        this._convertGeometries([target]);
        this._markRebuildGeometry();
        redraw(this);
    }

    onGeometryPositionChange(e) {
        const target = e.target['_getParent']() || e.target;
        const uid = target[ID_PROP];
        // 为应对同一个数据的频繁修改，发生变化的数据留到下一帧再统一修改
        this._dirtyTargetsInCurrentFrame[uid] = target;
        redraw(this);
    }

    onGeometryZIndexChange() {
        // nothing need to be done
    }

    onGeometryShow(e) {
        this._onShowHide(e);
    }

    onGeometryHide(e) {
        this._onShowHide(e);
    }

    _onShowHide(e) {
        const geo = e.target;
        const uid = geo[ID_PROP];
        const features = this.features[uid];
        if (features) {
            const visible = geo.isVisible();
            if (Array.isArray(features)) {
                if (visible === features[0].visible) {
                    return;
                }
                for (let i = 0; i < features.length; i++) {
                    features[i].visible = visible;
                }
            } else {
                if (visible === features.visible) {
                    return;
                }
                features.visible = visible;
            }
            this._markShowHide();
            redraw(this);
        }
    }

    _markShowHide() {
        this._showHideUpdated = true;
    }

    onGeometryPropertiesChange(e) {
        //TODO 可能会更新textName
        // this._markRebuildGeometry();
        const geo = e.target;
        const uid = geo[ID_PROP];
        this.features[uid] = convertToFeature(geo, this._kidGen);
        if (Array.isArray(this.features[uid])) {
            const feature = this.features[uid];
            for (let i = 0; i < feature.length; i++) {
                feature[i][ID_PROP] = uid;
            }
        } else {
            this.features[uid][ID_PROP] = uid;
        }

        this._refreshFeatures(this.features[uid]);
        this._markRebuild();
        redraw(this);
    }

    createContext() {
        const inGroup = this.canvas.gl && this.canvas.gl.wrap;
        if (inGroup) {
            this.gl = this.canvas.gl.wrap();
            this.regl = this.canvas.gl.regl;
        } else {
            this._createREGLContext();
        }
        if (inGroup) {
            this.canvas.pickingFBO = this.canvas.pickingFBO || this.regl.framebuffer(this.canvas.width, this.canvas.height);
        }
        this.prepareRequestors();
        this.pickingFBO = this.canvas.pickingFBO || this.regl.framebuffer(this.canvas.width, this.canvas.height);
        this.painter = this.createPainter();
        const IconPainter = Vector3DLayer.get3DPainterClass('icon');
        const markerSymbol = extend({}, MARKER_SYMBOL, TEXT_SYMBOL);
        this._markerPainter = new IconPainter(this.regl, this.layer, markerSymbol, this.layer.options.sceneConfig, 0);

        const LinePainter = Vector3DLayer.get3DPainterClass('line');
        const lineSymbol = extend({}, LINE_SYMBOL);
        this._linePainter = new LinePainter(this.regl, this.layer, lineSymbol, this.layer.options.sceneConfig, 0);

        if (this.layer.getGeometries()) {
            this.onGeometryAdd(this.layer.getGeometries());
        }
    }

    createPainter() {

    }

    _createREGLContext() {
        const layer = this.layer;

        const attributes = layer.options.glOptions || {
            alpha: true,
            depth: true,
            antialias: false
            // premultipliedAlpha : false
        };
        attributes.preserveDrawingBuffer = true;
        attributes.stencil = true;
        this.glOptions = attributes;
        this.gl = this.gl || this._createGLContext(this.canvas, attributes);
        this.regl = createREGL({
            gl: this.gl,
            attributes,
            extensions: reshader.Constants['WEBGL_EXTENSIONS'],
            optionalExtensions: reshader.Constants['WEBGL_OPTIONAL_EXTENSIONS']
        });
    }

    _createGLContext(canvas, options) {
        const names = ['webgl', 'experimental-webgl'];
        let context = null;
        /* eslint-disable no-empty */
        for (let i = 0; i < names.length; ++i) {
            try {
                context = canvas.getContext(names[i], options);
            } catch (e) { }
            if (context) {
                break;
            }
        }
        return context;
        /* eslint-enable no-empty */
    }

    clearCanvas() {
        super.clearCanvas();
        if (!this.regl) {
            return;
        }
        //这里必须通过regl来clear，如果直接调用webgl context的clear，则brdf的texture会被设为0
        this.regl.clear({
            color: [0, 0, 0, 0],
            depth: 1,
            stencil: 0xFF
        });
    }

    resizeCanvas(canvasSize) {
        super.resizeCanvas(canvasSize);
        const canvas = this.canvas;
        if (!canvas) {
            return;
        }
        if (this.pickingFBO && (this.pickingFBO.width !== canvas.width || this.pickingFBO.height !== canvas.height)) {
            this.pickingFBO.resize(canvas.width, canvas.height);
        }
        if (this.painter) {
            this.painter.resize(canvas.width, canvas.height);
        }
    }

    onRemove() {
        super.onRemove();
        if (this.painter) {
            this.painter.delete();
        }
        if (this._markerPainter) {
            this._markerPainter.delete();
        }
        if (this._linePainter) {
            this._linePainter.delete();
        }
    }

    drawOutline(fbo) {
        if (this._outlineAll) {
            if (this.painter) {
                this.painter.outlineAll(fbo);
            }
            this._markerPainter.outlineAll(fbo);
            this._linePainter.outlineAll(fbo);
        }
        if (this._outlineFeatures) {
            for (let i = 0; i < this._outlineFeatures.length; i++) {
                if (this.painter) {
                    this.painter.outline(fbo, this._outlineFeatures[i]);
                }
                this._markerPainter.outline(fbo, this._outlineFeatures[i]);
                this._linePainter.outline(fbo, this._outlineFeatures[i]);

            }
        }
    }

    outlineAll() {
        this._outlineAll = true;
        this.setToRedraw();
    }

    outline(geoIds) {
        if (!this._outlineFeatures) {
            this._outlineFeatures = [];
        }

        const featureIds = [];
        for (let i = 0; i < geoIds.length; i++) {
            const geo = this.layer.getGeometryById(geoIds[i]);
            if (geo) {
                const features = this.features[geo[ID_PROP]];
                if (Array.isArray(features)) {
                    for (let j = 0; j < features.length; j++) {
                        featureIds.push(features[j][KEY_IDX_NAME]);
                    }
                } else {
                    featureIds.push(features[KEY_IDX_NAME]);
                }
            }
        }
        this._outlineFeatures.push(featureIds);
        this.setToRedraw();
    }

    cancelOutline() {
        delete this._outlineAll;
        delete this._outlineFeatures;
        this.setToRedraw();
    }

    isEnableWorkAround(key) {
        if (key === 'win-intel-gpu-crash') {
            return this.layer.options['workarounds']['win-intel-gpu-crash'] && isWinIntelGPU(this.gl);
        }
        return false;
    }

    _getCentiMeterScale(z) {
        const map = this.getMap();
        const p = map.distanceToPoint(1000, 0, z).x;
        return p / 1000 / 10;
    }
}

function redraw(renderer) {
    renderer.setToRedraw();
}

function isWinIntelGPU(gl) {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo && typeof navigator !== 'undefined') {
        //e.g. ANGLE (Intel(R) HD Graphics 620
        const gpu = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        const win = navigator.platform === 'Win32' || navigator.platform === 'Win64';
        if (gpu && gpu.toLowerCase().indexOf('intel') >= 0 && win) {
            return true;
        }
    }
    return false;
}

export default Vector3DLayerRenderer;

function hasMarkerSymbol({ properties }) {
    return properties[prefix + 'markerFile'] || properties[prefix + 'markerType'];
}

function hasTextSymbol({ properties }) {
    return properties[prefix + 'textName'];
}

function hasLineSymbol(fea) {
    return fea.type === 2 || (fea.type === 3 && !!fea.properties[prefix + 'lineWidth']);
}

function dashLength(dash) {
    if (!Array.isArray(dash)) {
        return 0;
    }
    let len = 0;
    for (let i = 0; i < dash.length; i++) {
        len += dash[i];
    }
    return len;
}

function compareCoordSize(coords0, coords1) {
    if (coords0.length !== coords1.length) {
        return false;
    }
    if (Array.isArray(coords0[0]) && Array.isArray(coords1[0])) {
        for (let i = 0; i < coords0.length; i++) {
            if (!compareCoordSize(coords0[0], coords1[0])) {
                return false;
            }
        }
    } else if (Array.isArray(coords0[0]) || Array.isArray(coords1[0])) {
        return false;
    }
    return true;
}

function compareSymbolCount(symbol, feas) {
    if (Array.isArray(symbol)) {
        if (!Array.isArray(feas)) {
            return false;
        } else {
            return symbol.length === feas.length;
        }
    } else {
        return !Array.isArray(feas);
    }
}

function compareSymbolProp(symbol, feature) {
    const props = Object.keys(symbol).sort().join();
    const feaProps = Object.keys(feature.properties || {}).filter(p => p.indexOf(prefix) === 0).map(p => p.substring(prefix.length)).sort().join();
    if (props !== feaProps) {
        return false;
    }
    for (const p in symbol) {
        if (symbol.hasOwnProperty(p)) {
            // 如果有fn-type的属性被更新，则重新rebuild all
            if (isFunctionDefinition(symbol[p]) !== isFunctionDefinition(feature.properties[prefix + p])) {
                return false;
            }
        }
    }
    return true;
}
