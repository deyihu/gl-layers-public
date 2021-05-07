import * as maptalks from 'maptalks';
import { vec2, vec3, mat4 } from 'gl-matrix';
import { GLContext } from '@maptalks/fusiongl';
import ShadowPass from './shadow/ShadowProcess';
import * as reshader from '@maptalks/reshader.gl';
import createREGL from '@maptalks/regl';
import GroundPainter from './GroundPainter';
import EnvironmentPainter from './EnvironmentPainter';
import PostProcess from './postprocess/PostProcess.js';

const EMPTY_COLOR = [0, 0, 0, 0];

const MIN_SSR_PITCH = -0.001;
const NO_JITTER = [0, 0];

const noPostFilter = m => !m.bloom && !m.ssr;
const noBloomFilter = m => !m.bloom;
const noSsrFilter = m => !m.ssr;

const SSR_STATIC = 1;
const SSR_IN_ONE_FRAME = 2;

class Renderer extends maptalks.renderer.CanvasRenderer {

    setToRedraw() {
        this.setRetireFrames();
        super.setToRedraw();
    }

    onAdd() {
        super.onAdd();
        this.prepareCanvas();
    }

    updateSceneConfig() {
        if (this._groundPainter) {
            this._groundPainter.update();
        }
        if (this._envPainter) {
            this._envPainter.update();
        }
        this.setToRedraw();
    }

    render(...args) {
        if (!this.getMap() || !this.layer.isVisible()) {
            return;
        }
        this.forEachRenderer((renderer) => {
            if (renderer._replacedDrawFn) {
                return;
            }
            renderer.draw = this._buildDrawFn(renderer.draw);
            renderer.drawOnInteracting = this._buildDrawOnInteractingFn(renderer.drawOnInteracting);
            renderer.setToRedraw = this._buildSetToRedrawFn(renderer.setToRedraw);
            renderer._replacedDrawFn = true;
        });
        this.prepareRender();
        this.prepareCanvas();
        this.layer._updatePolygonOffset();
        this['_toRedraw'] = false;
        this._renderChildLayers('render', args);
        this._renderOutlines();
        this._postProcess();
    }

    prepareCanvas() {
        super.prepareCanvas();
        this.forEachRenderer(renderer => {
            renderer.prepareCanvas();
        });
    }

    drawOnInteracting(...args) {
        if (!this.getMap() || !this.layer.isVisible()) {
            return;
        }
        this.layer._updatePolygonOffset();
        this['_toRedraw'] = false;
        this._renderChildLayers('drawOnInteracting', args);
        this._renderOutlines();
        this._postProcess();
    }

    _renderChildLayers(methodName, args) {
        this._renderMode = 'default';
        const drawContext = this._getDrawContext(args);
        if (!this._envPainter) {
            this._envPainter = new EnvironmentPainter(this.regl, this.layer);
        }
        this._envPainter.paint(drawContext);
        //如果放到图层后画，会出现透明图层下的ground消失的问题，#145
        this.drawGround(true);

        const hasRenderTarget = this.hasRenderTarget();
        if (!hasRenderTarget) {
            this._renderInMode('default', null, methodName, args, true);
            return;
        }

        const sceneConfig =  this.layer._getSceneConfig();
        const config = sceneConfig && sceneConfig.postProcess;
        const ssrMode = this.isSSROn();

        const enableTAA = this.isEnableTAA();
        const jitter = drawContext.jitter;
        drawContext.jitter = NO_JITTER;
        this._renderInMode(enableTAA ? 'fxaaBeforeTaa' : 'fxaa', this._targetFBO, methodName, args);

        // 重用上一帧的深度纹理，先绘制ssr图形
        // 解决因TAA jitter偏转，造成的ssr图形与taa图形的空白缝隙问题
        // #1545 SSR_ONE_FRAME模式里，建筑透明时，ssr后画会造成建筑后的ssr图形丢失，改为永远在每帧的开始，都绘制ssr图形
        if (ssrMode) {
            this._postProcessor.drawSSR(this._depthTex, this._targetFBO);
        }


        const fGL = this.glCtx;
        if (enableTAA) {
            const map = this.getMap();
            const needRefresh = this._postProcessor.isTaaNeedRedraw() || this._needRetireFrames || map.getRenderer().isViewChanged();
            drawContext.jitter = needRefresh ? jitter : this._jitGetter.getAverage();
            drawContext.onlyUpdateDepthInTaa = !needRefresh;
            let taaFBO = this._taaFBO;
            if (!taaFBO) {
                const regl = this.regl;
                const info = this._createFBOInfo(config, this._depthTex);
                taaFBO = this._taaFBO = regl.framebuffer(info);
            } else if (taaFBO.width !== this._targetFBO.width || taaFBO.height !== this._targetFBO.height) {
                taaFBO.resize(this._targetFBO.width, this._targetFBO.height);
            }
            fGL.resetDrawCalls();
            this._renderInMode('taa', taaFBO, methodName, args);
            this._taaDrawCount = fGL.getDrawCalls();
            delete drawContext.onlyUpdateDepthInTaa;
            drawContext.jitter = NO_JITTER;

            let fxaaFBO = this._fxaaFBO;
            if (!fxaaFBO) {
                const regl = this.regl;
                const info = this._createFBOInfo(config, this._depthTex);
                fxaaFBO = this._fxaaFBO = regl.framebuffer(info);
            } else if (fxaaFBO.width !== this._targetFBO.width || fxaaFBO.height !== this._targetFBO.height) {
                fxaaFBO.resize(this._targetFBO.width, this._targetFBO.height);
            }
            fGL.resetDrawCalls();
            this._renderInMode('fxaaAfterTaa', this._fxaaFBO, methodName, args);
            this._fxaaAfterTaaDrawCount = fGL.getDrawCalls();
        } else if (this._taaFBO) {
            this._taaFBO.destroy();
            this._fxaaFBO.destroy();
            delete this._taaFBO;
            delete this._fxaaFBO;
            delete this._fxaaAfterTaaDrawCount;
        }

        // let tex = this._fxaaFBO ? this._fxaaFBO.color[0] : this._targetFBO.color[0];

        // bloom的绘制放在ssr之前，更新深度缓冲，避免ssr绘制时，深度值不正确
        const enableBloom = config.bloom && config.bloom.enable;
        if (enableBloom) {
            this._bloomPainted = this._postProcessor.drawBloom(this._depthTex);
        }

        // ssr如果放到noAa之后，ssr图形会遮住noAa中的图形
        if (ssrMode === SSR_IN_ONE_FRAME) {
            this._postProcessor.drawSSR(this._depthTex, this._targetFBO, true);
        }

        // noAa的绘制放在bloom后，避免noAa的数据覆盖了bloom效果
        fGL.resetDrawCalls();
        this._renderInMode('noAa', this._noAaFBO, methodName, args, true);
        this._noaaDrawCount = fGL.getDrawCalls();

        // return tex;
    }

    _renderInMode(mode, fbo, methodName, args, isFinalRender) {
        //noAA需要最后绘制，如果有noAa的图层，分为aa和noAa两个阶段分别绘制
        this._renderMode = mode;
        const drawContext = this._getDrawContext(args);
        drawContext.renderMode = this._renderMode;
        if (drawContext.renderTarget) {
            drawContext.renderTarget.fbo = fbo;
        }
        if (isFinalRender) {
            drawContext.isFinalRender = true;
        }

        this.forEachRenderer((renderer, layer) => {
            if (!layer.isVisible()) {
                return;
            }
            if (mode === 'default' ||
                !renderer.supportRenderMode && (mode === 'fxaa' || mode === 'fxaaAfterTaa') ||
                renderer.supportRenderMode && renderer.supportRenderMode(mode)) {
                this.clearStencil(renderer, fbo);
                renderer[methodName].apply(renderer, args);
            }
        });
    }

    _getDrawContext(args) {
        let timestamp = args[0];
        if (!isNumber(timestamp)) {
            timestamp = args[1];
        }
        if (timestamp !== this._contextFrameTime) {
            this.forEachRenderer((renderer, layer) => {
                if (!layer.isVisible()) {
                    return;
                }
                if (renderer.needRetireFrames && renderer.needRetireFrames()) {
                    this.setRetireFrames();
                }
            });
            this._drawContext = this._prepareDrawContext(timestamp);
            this._contextFrameTime = timestamp;
            this._frameEvent = isNumber(args[0]) ? null : args[0];
        }
        return this._drawContext;
    }

    _renderOutlines() {
        if (!this.isEnableOutline()) {
            return;
        }
        const fbo = this._getOutlineFBO();

        const fGl = this.glCtx;
        fGl.resetDrawCalls();
        this.forEachRenderer((renderer, layer) => {
            if (!layer.isVisible()) {
                return;
            }
            if (renderer.drawOutline) {
                renderer.drawOutline(fbo);
            }
        });
        this._outlineCounts = fGl.getDrawCalls();
    }

    _getOutlineFBO() {
        const { width, height } = this.canvas;
        let fbo = this._outlineFBO;
        if (!fbo) {
            const outlineTex = this.regl.texture({
                width: width,
                height: height,
                format: 'rgba4'
            });
            fbo = this._outlineFBO = this.regl.framebuffer({
                width: width,
                height: height,
                colors: [outlineTex],
                depth: false,
                stencil: false
            });
        } else if (width !== fbo.width || height !== fbo.height) {
            fbo.resize(width, height);
        }
        return fbo;
    }

    hasRenderTarget() {
        const sceneConfig =  this.layer._getSceneConfig();
        const config = sceneConfig && sceneConfig.postProcess;
        if (!config || !config.enable) {
            return false;
        }
        return true;
    }

    testIfNeedRedraw() {
        if (this['_toRedraw']) {
            this['_toRedraw'] = false;
            return true;
        }
        const map = this.getMap();
        if (map.isInteracting() && this._groundPainter && this._groundPainter.isEnable()) {
            return true;
        }
        const layers = this.layer.getLayers();
        for (const layer of layers) {
            const renderer = layer.getRenderer();
            if (renderer && renderer.testIfNeedRedraw()) {
                // 如果图层发生变化，保存的depthTexture可能发生变化，所以ssr需要多重绘一次，更新depthTexture
                this._needUpdateSSR = true;
                return true;
            }
        }
        return false;
    }

    // _isLayerEnableTAA(renderer) {
    //     return this.isEnableTAA() && renderer.supportRenderMode && renderer.supportRenderMode('taa');
    // }

    isRenderComplete() {
        const layers = this.layer.getLayers();
        for (const layer of layers) {
            const renderer = layer.getRenderer();
            if (renderer && !renderer.isRenderComplete()) {
                return false;
            }
        }
        return true;
    }

    mustRenderOnInteracting() {
        const layers = this.layer.getLayers();
        for (const layer of layers) {
            const renderer = layer.getRenderer();
            if (renderer && renderer.mustRenderOnInteracting()) {
                return true;
            }
        }
        return false;
    }

    isCanvasUpdated() {
        if (super.isCanvasUpdated()) {
            return true;
        }
        const layers = this.layer.getLayers();
        for (const layer of layers) {
            const renderer = layer.getRenderer();
            if (renderer && renderer.isCanvasUpdated()) {
                return true;
            }
        }
        return false;
    }

    isBlank() {
        if (this._groundPainter && this._groundPainter.isEnable()) {
            return false;
        }
        const layers = this.layer.getLayers();
        for (const layer of layers) {
            const renderer = layer.getRenderer();
            if (renderer && !renderer.isBlank()) {
                return false;
            }
        }
        return true;
    }

    createContext() {
        const layer = this.layer;
        const attributes = layer.options['glOptions'] || {
            alpha: true,
            depth: true,
            stencil: true
        };
        attributes.preserveDrawingBuffer = true;
        attributes.antialias = layer.options['antialias'];
        this.glOptions = attributes;
        const gl = this.gl = this._createGLContext(this.canvas, attributes);        // this.gl = gl;
        this._initGL(gl);
        gl.wrap = () => {
            return new GLContext(this.gl);
        };
        this.glCtx = gl.wrap();
        this.canvas.gl = this.gl;
        this.reglGL = gl.wrap();
        this.regl = createREGL({
            gl: this.reglGL,
            attributes,
            extensions: layer.options['extensions'],
            optionalExtensions: layer.options['optionalExtensions']
        });
        this.gl.regl = this.regl;
        this._jitter = [0, 0];
    }

    _initGL() {
        const layer = this.layer;
        const gl = this.gl;
        const extensions = layer.options['extensions'];
        if (extensions) {
            extensions.forEach(ext => {
                gl.getExtension(ext);
            });
        }
        const optionalExtensions = layer.options['optionalExtensions'];
        if (optionalExtensions) {
            optionalExtensions.forEach(ext => {
                gl.getExtension(ext);
            });
        }
        this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    }

    clearCanvas() {
        super.clearCanvas();
        this._clearFramebuffers();
    }

    _clearFramebuffers() {
        const regl = this.regl;
        if (this._targetFBO) {
            regl.clear({
                color: EMPTY_COLOR,
                depth: 1,
                stencil: 0xFF,
                framebuffer: this._targetFBO
            });
            regl.clear({
                color: EMPTY_COLOR,
                framebuffer: this._noAaFBO
            });
            if (this._taaFBO && this._taaDrawCount) {
                regl.clear({
                    color: EMPTY_COLOR,
                    framebuffer: this._taaFBO
                });
            }
            if (this._fxaaFBO && this._fxaaAfterTaaDrawCount) {
                regl.clear({
                    color: EMPTY_COLOR,
                    framebuffer: this._fxaaFBO
                });
            }
        }
        if (this._outlineFBO) {
            regl.clear({
                color: EMPTY_COLOR,
                framebuffer: this._outlineFBO
            });
        }
        regl.clear({
            color: EMPTY_COLOR,
            depth: 1,
            stencil: 0xFF
        });
    }

    resizeCanvas() {
        super.resizeCanvas();
        const width = this.canvas.width;
        const height = this.canvas.height;
        if (this._targetFBO && (this._targetFBO.width !== width ||
            this._targetFBO.height !== height)) {
            this._targetFBO.resize(width, height);
            this._noAaFBO.resize(width, height);
            if (this._taaFBO) {
                this._taaFBO.resize(width, height);
            }
            if (this._fxaaFBO) {
                this._fxaaFBO.resize(width, height);
            }
        }
        this.forEachRenderer(renderer => {
            if (renderer.canvas) {
                renderer.resizeCanvas();
            }
        });
    }

    getCanvasImage() {
        this.forEachRenderer(renderer => {
            renderer.getCanvasImage();
        });
        return super.getCanvasImage();
    }

    forEachRenderer(fn) {
        const layers = this.layer.getLayers();
        for (const layer of layers) {
            const renderer = layer.getRenderer();
            if (renderer) {
                fn(renderer, layer);
            }
        }
    }

    _createGLContext(canvas, options) {
        const layer = this.layer;
        const names = layer.options['onlyWebGL1'] ? ['webgl', 'experimental-webgl'] : ['webgl2', 'webgl', 'experimental-webgl'];
        let gl = null;
        /* eslint-disable no-empty */
        for (let i = 0; i < names.length; ++i) {
            try {
                gl = canvas.getContext(names[i], options);
            } catch (e) {}
            if (gl) {
                break;
            }
        }
        return gl;
        /* eslint-enable no-empty */
    }

    clearStencil(renderer, fbo) {
        const stencilValue = renderer.getStencilValue ? renderer.getStencilValue() : 0xFF;
        const config = {
            stencil: stencilValue
        };
        if (fbo) {
            config['framebuffer'] = fbo;
        }
        this.regl.clear(config);
    }

    onRemove() {
        //regl framebuffer for picking created by children layers
        if (this.canvas.pickingFBO && this.canvas.pickingFBO.destroy) {
            this.canvas.pickingFBO.destroy();
        }
        this._destroyFramebuffers();
        if (this._groundPainter) {
            this._groundPainter.dispose();
            delete this._groundPainter;
        }
        if (this._envPainter) {
            this._envPainter.dispose();
            delete this._envPainter;
        }
        if (this._shadowPass) {
            this._shadowPass.dispose();
            delete this._shadowPass;
        }
        if (this._postProcessor) {
            this._postProcessor.dispose();
            delete this._postProcessor;
        }
        if (this._outlineFBO) {
            this._outlineFBO.destroy();
            delete this._outlineFBO;
        }
        super.onRemove();
    }

    _destroyFramebuffers() {
        if (this._targetFBO) {
            this._targetFBO.destroy();
            this._noAaFBO.destroy();
            if (this._taaFBO) {
                this._taaFBO.destroy();
                delete this._taaFBO;
            }
            if (this._fxaaFBO) {
                this._fxaaFBO.destroy();
                delete this._fxaaFBO;
            }
            delete this._targetFBO;
            delete this._noAaFBO;
            if (this._postFBO) {
                this._postFBO.destroy();
                delete this._postFBO;
            }
        }
    }

    setRetireFrames() {
        this._needRetireFrames = true;
    }

    getFrameTime() {
        return this._contextFrameTime;
    }

    getFrameEvent() {
        return this._frameEvent;
    }

    getFrameContext() {
        return this._drawContext;
    }

    drawGround(forceRender) {
        if (!this._groundPainter) {
            this._groundPainter = new GroundPainter(this.regl, this.layer);
        }
        const context = this.getFrameContext();
        const jitter = context.jitter;
        //地面绘制不用引入jitter，会导致地面的晃动
        context.jitter = NO_JITTER;
        // 1 是留给开启了ssr的图形的
        context.offsetFactor = 2;
        context.offsetUnits = 2;
        let sceneFilter;
        if (forceRender) {
            // 第一次绘制 ground 应该忽略 sceneFilter
            // 否则 noSSRFilter 会把 ground 过滤掉
            // 但当场景有透明物体时，物体背后没画ground，出现绘制问题。
            sceneFilter = context.sceneFilter;
            delete context.sceneFilter;
        }
        const drawn = this._groundPainter.paint(context);
        if (sceneFilter) {
            context.sceneFilter = sceneFilter;
        }
        context.jitter = jitter;
        return drawn;
    }

    _buildDrawFn(drawMethod) {
        const me = this;
        //drawBloom中会手动创建context
        return function (timestamp, context) {
            const hasRenderTarget = context && context.renderTarget;
            if (hasRenderTarget) {
                context.renderTarget.getFramebuffer = getFramebuffer;
                context.renderTarget.getDepthTexture = getDepthTexture;
            }
            return drawMethod.call(this, timestamp, context || me._drawContext);
        };
    }

    _buildDrawOnInteractingFn(drawMethod) {
        const me = this;
        //drawBloom中会手动创建context
        return function (event, timestamp, context) {
            const hasRenderTarget = context && context.renderTarget;
            if (hasRenderTarget) {
                context.renderTarget.getFramebuffer = getFramebuffer;
                context.renderTarget.getDepthTexture = getDepthTexture;
            }
            return drawMethod.call(this, event, timestamp, context || me._drawContext);
        };
    }

    _buildSetToRedrawFn(fn) {
        return function (...args) {
            return fn.apply(this, args);
        };
    }

    isEnableSSR() {
        const sceneConfig =  this.layer._getSceneConfig();
        const config = sceneConfig && sceneConfig.postProcess;
        return config && config.enable && config.ssr && config.ssr.enable;
    }

    isSSROn() {
        const enable = this.isEnableSSR();
        const map = this.getMap();
        if (!enable || map.getPitch() <= MIN_SSR_PITCH) {
            return 0;
        }
        const projViewMat = map.projViewMatrix;
        const prevSsrMat = this._postProcessor.getPrevSsrProjViewMatrix();
        return prevSsrMat && mat4.exactEquals(prevSsrMat, projViewMat) ? SSR_STATIC : SSR_IN_ONE_FRAME;
        // return SSR_IN_ONE_FRAME;
        // SSR_STATIC的思路是直接利用上一帧的深度纹理，来绘制ssr，这样无需额外的ssr pass。
        // 但当场景里有透明的物体时，被物体遮住的倒影会在SSR_STATIC阶段中绘制，但在SSR_IN_ONE_FRAME中不绘制，出现闪烁，故取消SSR_STATIC
        // 2021-01-11 fuzhen 该问题通过在ssr shader中，通过手动比较深度值，决定是否绘制解决
        // 2021-02-05 fuzhen 通过在drawSSR前copyDepth，ssr统一在StandardShader中绘制，不再需要ssr后处理, 之后SSR_IN_ONE_FRAME相比SSR_STATIC，只是多了drawSSR
        // 2021-02-07 fuzhen ssr绘制顺序不同，会导致一些绘制问题，改为统一用SSR_IN_ONE_FRAME
        // 2021-02-11 fuzhen 重新分为SSR_STATIC和SSR_IN_ONE_FRAME，SSR_STATIC时重用上一帧depth纹理，在taa前绘制ssr图形，解决taa抖动造成的ssr图形边缘缝隙问题
    }

    isEnableTAA() {
        const sceneConfig =  this.layer._getSceneConfig();
        const config = sceneConfig && sceneConfig.postProcess;
        return config && config.antialias && config.antialias.enable && config.antialias.taa;
    }

    isEnableSSAO() {
        const sceneConfig =  this.layer._getSceneConfig();
        const config = sceneConfig && sceneConfig.postProcess;
        return config && config.enable && config.ssao && config.ssao.enable;
    }

    isEnableOutline() {
        const sceneConfig =  this.layer._getSceneConfig();
        const config = sceneConfig && sceneConfig.postProcess;
        return config && config.enable && config.outline && config.outline.enable;
    }

    _getViewStates() {
        const map = this.layer.getMap();

        const renderedView = this._renderedView;
        if (!renderedView) {
            this._renderedView = {
                center: map.getCenter(),
                bearing: map.getBearing(),
                pitch: map.getPitch(),
                res: map.getResolution()
                // count: scene.getMeshes().length - (displayShadow ? 1 : 0)
            };
            let lightDirectionChanged = false;
            if (map.options.lights) {
                const lightManager = map.getLightManager();
                const lightDirection = lightManager.getDirectionalLight().direction;
                this._renderedView.lightDirection = vec3.copy([], lightDirection);
                lightDirectionChanged = true;
            }
            return {
                viewChanged: true,
                lightDirectionChanged
            };
        }
        const res = map.getResolution();
        const scale = res / this._renderedView.res;
        // const maxPitch = map.options['cascadePitches'][2];
        // const pitch = map.getPitch();
        const cp = map.coordToContainerPoint(this._renderedView.center);
        const viewMoveThreshold = this.layer.options['viewMoveThreshold'];
        // const viewPitchThreshold = this.layer.options['viewPitchThreshold'];
        const viewChanged = (cp._sub(map.width / 2, map.height / 2).mag() > viewMoveThreshold) || scale < 0.95 || scale > 1.05;
        // Math.abs(renderedView.bearing - map.getBearing()) > 30 ||
        // (renderedView.pitch < maxPitch || pitch < maxPitch) && Math.abs(renderedView.pitch - pitch) > viewPitchThreshold;
        let lightDirectionChanged = false;
        if (map.options.lights) {
            const lightManager = map.getLightManager();
            const lightDirection = lightManager.getDirectionalLight().direction;
            lightDirectionChanged = !vec3.equals(this._renderedView.lightDirection, lightDirection);
            if (lightDirectionChanged) {
                this._renderedView.lightDirection = vec3.copy([], lightDirection);
            }
        }
        //update renderView
        if (viewChanged) {
            this._renderedView.center = map.getCenter();
            this._renderedView.bearing = map.getBearing();
            this._renderedView.pitch = map.getPitch();
            this._renderedView.res = map.getResolution();
        }
        return {
            viewChanged,
            lightDirectionChanged
        };
    }



    _prepareDrawContext(timestamp) {
        const sceneConfig =  this.layer._getSceneConfig();
        const config = sceneConfig && sceneConfig.postProcess;
        const context = {
            timestamp,
            renderMode: this._renderMode || 'default',
            includes: {},
            states: this._getViewStates(),
            testSceneFilter: mesh => {
                return !context.sceneFilter || context.sceneFilter(mesh);
            },
            isFinalRender: false
        };

        const ratio = config && config.antialias && config.antialias.jitterRatio || 0.2;
        let jitGetter = this._jitGetter;
        if (!jitGetter) {
            jitGetter = this._jitGetter = new reshader.Jitter(ratio);
        } else {
            jitGetter.setRatio(ratio);
        }

        if (!this._postProcessor) {
            this._postProcessor = new PostProcess(this.regl, this.layer, this._jitGetter);
        }

        const ssrMode = this.isSSROn();
        let renderTarget;
        if (!config || !config.enable) {
            this._destroyFramebuffers();
        } else {
            const hasJitter = this.isEnableTAA();
            if (hasJitter) {
                const map = this.getMap();
                if (map.isInteracting() || this._needRetireFrames) {
                    jitGetter.reset();
                }
                jitGetter.getJitter(this._jitter);
                jitGetter.frame();
            } else {
                vec2.set(this._jitter, 0, 0);
            }
            context['jitter'] = this._jitter;
            const enableBloom = config.bloom && config.bloom.enable;
            if (enableBloom && ssrMode) {
                context['bloom'] = 1;
                context['sceneFilter'] = noPostFilter;
            } else if (enableBloom) {
                context['bloom'] = 1;
                context['sceneFilter'] = noBloomFilter;
            } else if (ssrMode) {
                context['sceneFilter'] = noSsrFilter;
            }

            renderTarget = this._getFramebufferTarget();
            if (renderTarget) {
                context.renderTarget = renderTarget;
            }
        }
        this._renderAnalysis(context, renderTarget);
        if (this._renderMode !== 'noAa') {

            this._shadowContext = this._prepareShadowContext(context);
            if (this._shadowContext) {
                context.includes.shadow = 1;
            }
            this._includesState = this._updateIncludesState(context);
        }
        if (this._shadowContext) {
            context.shadow = this._shadowContext;
            context.includes.shadow = 1;
        }
        context.states.includesChanged = this._includesState;
        if (config && config.enable && this._postProcessor) {
            this._postProcessor.setContextIncludes(context);
        }
        // 2021-02-20 ssr的绘制全部统一到了drawSSR中，而不会在平时的绘制阶段绘制ssr了
        // if (ssrMode === SSR_STATIC) {
        //     const ssr = this._postProcessor.getSSRContext();
        //     if (ssr) {
        //         context.ssr = ssr;
        //     }
        // }
        return context;
    }

    _renderAnalysis(context, renderTarget) {
        let toAnalyseMeshes = [];
        this.forEachRenderer(renderer => {
            if (!renderer.getAnalysisMeshes) {
                return;
            }
            const meshes = renderer.getAnalysisMeshes();
            if (Array.isArray(meshes)) {
                for (let i = 0; i < meshes.length; i++) {
                    toAnalyseMeshes.push(meshes[i]);
                }
            }
        });
        const analysisTaskList = this.layer._analysisTaskList;
        if (!analysisTaskList) {
            return;
        }
        for (let i = 0; i < analysisTaskList.length; i++) {
            const task = analysisTaskList[i];
            task.renderAnalysis(context, toAnalyseMeshes, renderTarget && renderTarget.fbo);
        }
    }

    _updateIncludesState(context) {
        let state = false;
        const includeKeys = Object.keys(context.includes);
        const prevKeys = this._prevIncludeKeys;
        if (prevKeys) {
            const difference = includeKeys
                .filter(x => prevKeys.indexOf(x) === -1)
                .concat(prevKeys.filter(x => includeKeys.indexOf(x) === -1));
            if (difference.length) {
                state = difference.reduce((accumulator, currentValue) => {
                    accumulator[currentValue] = 1;
                    return accumulator;
                }, {});
            }
        }
        this._prevIncludeKeys = includeKeys;
        return state;
    }

    _prepareShadowContext(context) {
        const sceneConfig =  this.layer._getSceneConfig();
        if (!sceneConfig || !sceneConfig.shadow || !sceneConfig.shadow.enable) {
            if (this._shadowPass) {
                this._shadowPass.dispose();
                delete this._shadowPass;
            }
            return null;
        }
        if (!this._shadowPass) {
            this._shadowPass = new ShadowPass(this.regl, sceneConfig, this.layer);
        }
        const shadow = {
            config: sceneConfig.shadow,
            defines: this._shadowPass.getDefines(),
            uniformDeclares: ShadowPass.getUniformDeclares()
        };
        shadow.renderUniforms = this._renderShadow(context);
        return shadow;
    }

    _renderShadow(context) {
        const fbo = context.renderTarget && context.renderTarget.fbo;
        const sceneConfig =  this.layer._getSceneConfig();
        const meshes = [];
        let forceUpdate = context.states.lightDirectionChanged || context.states.viewChanged;
        this.forEachRenderer(renderer => {
            if (!renderer.getShadowMeshes) {
                return;
            }
            const shadowMeshes = renderer.getShadowMeshes();
            if (Array.isArray(shadowMeshes)) {
                for (let i = 0; i < shadowMeshes.length; i++) {
                    if (shadowMeshes[i].needUpdateShadow) {
                        forceUpdate = true;
                    }
                    shadowMeshes[i].needUpdateShadow = false;
                    meshes.push(shadowMeshes[i]);
                }
            }
        });
        // if (!meshes.length) {
        //     return null;
        // }
        if (!this._shadowScene) {
            this._shadowScene = new reshader.Scene();
        }
        this._shadowScene.setMeshes(meshes);
        const map = this.getMap();
        const shadowConfig = sceneConfig.shadow;
        const lightDirection = map.getLightManager().getDirectionalLight().direction;
        const displayShadow = !sceneConfig.ground || !sceneConfig.ground.enable;
        const uniforms = this._shadowPass.render(displayShadow, map.projMatrix, map.viewMatrix, shadowConfig.color, shadowConfig.opacity, lightDirection, this._shadowScene, this._jitter, fbo, forceUpdate);
        // if (this._shadowPass.isUpdated()) {
        //     this.setRetireFrames();
        // }
        return uniforms;
    }

    _getFramebufferTarget() {
        const sceneConfig =  this.layer._getSceneConfig();
        const config = sceneConfig && sceneConfig.postProcess;
        if (!this._targetFBO) {
            const regl = this.regl;
            let depthTex = this._depthTex;
            if (!depthTex || !depthTex['_texture'] || depthTex['_texture'].refCount <= 0) {
                depthTex = null;
            }
            const fboInfo = this._createFBOInfo(config, depthTex);
            this._depthTex = fboInfo.depth || fboInfo.depthStencil;
            this._targetFBO = regl.framebuffer(fboInfo);
            const noAaInfo = this._createFBOInfo(config, this._depthTex);
            this._noAaFBO = regl.framebuffer(noAaInfo);
            this._clearFramebuffers();
        }
        return {
            fbo: this._targetFBO
        };
    }

    _createSimpleFBOInfo() {
        const width = this.canvas.width, height = this.canvas.height;
        const regl = this.regl;
        const type = 'uint8';//colorType || regl.hasExtension('OES_texture_half_float') ? 'float16' : 'float';
        const color = regl.texture({
            min: 'nearest',
            mag: 'nearest',
            type,
            width,
            height
        });
        const fboInfo = {
            width,
            height,
            colors: [color],
            // stencil: true,
            // colorCount,
            colorFormat: 'rgba'
        };
        return fboInfo;
    }

    _createFBOInfo(config, depthTex) {
        const { width, height } = this.canvas;
        const regl = this.regl;
        const fboInfo = this._createSimpleFBOInfo();
        const enableDepthTex = regl.hasExtension('WEBGL_depth_texture');
        //depth(stencil) buffer 是可以共享的
        if (enableDepthTex) {
            const depthStencilTexture = depthTex || regl.texture({
                min: 'nearest',
                mag: 'nearest',
                mipmap: false,
                type: 'depth stencil',
                width,
                height,
                format: 'depth stencil'
            });
            fboInfo.depthStencil = depthStencilTexture;
        } else {
            const renderbuffer = depthTex || regl.renderbuffer({
                width,
                height,
                format: 'depth stencil'
            });
            fboInfo.depthStencil = renderbuffer;
        }
        return fboInfo;
    }

    _postProcess() {
        if (!this._targetFBO) {
            this._needRetireFrames = false;
            return;
        }
        const sceneConfig =  this.layer._getSceneConfig();
        const config = sceneConfig && sceneConfig.postProcess;
        if (!config || !config.enable) {
            return;
        }
        const map = this.layer.getMap();

        const enableTAA = this.isEnableTAA();
        let taaTex;
        if (enableTAA) {
            const { outputTex, redraw } = this._postProcessor.taa(this._taaFBO.color[0], this._depthTex, {
                projMatrix: map.projMatrix,
                needClear: this._needRetireFrames || map.getRenderer().isViewChanged()
            });
            taaTex = outputTex;
            if (redraw) {
                this.setToRedraw();
            }
            this._needRetireFrames = false;
        }

        let sharpFactor = config.sharpen && config.sharpen.factor;
        if (!sharpFactor && sharpFactor !== 0) {
            sharpFactor = 0.2;// 0 - 5
        }

        let enableOutline = 0;
        let highlightFactor = 0.2;
        let outlineFactor = 0.3;
        let outlineWidth = 1;
        let outlineColor = [1, 1, 0];
        if (config.outline) {
            enableOutline = +!!config.outline.enable;
            highlightFactor = getValueOrDefault(config.outline, 'highlightFactor', highlightFactor);
            outlineFactor = getValueOrDefault(config.outline, 'outlineFactor', outlineFactor);
            outlineWidth = getValueOrDefault(config.outline, 'outlineWidth', outlineWidth);
            outlineColor = getValueOrDefault(config.outline, 'outlineColor', outlineColor);
        }

        const enableSSAO = this.isEnableSSAO();
        const enableSSR = config.ssr && config.ssr.enable;
        const enableBloom = config.bloom && config.bloom.enable;
        const enableAntialias = +!!(config.antialias && config.antialias.enable);
        const hasPost = enableSSAO || enableBloom;

        let postFBO = this._postFBO;
        if (hasPost) {
            if (!postFBO) {
                const info = this._createSimpleFBOInfo();
                postFBO = this._postFBO = this.regl.framebuffer(info);
            }
            const { width, height } = this.canvas;
            if (postFBO.width !== width || postFBO.height !== height) {
                postFBO.resize(width, height);
            }
        } else {
            postFBO = null;
            if (this._postFBO) {
                this._postFBO.destroy();
                delete this._postFBO;
            }
        }

        let tex = this._targetFBO.color[0];

        // const enableFXAA = config.antialias && config.antialias.enable && (config.antialias.fxaa || config.antialias.fxaa === undefined);
        this._postProcessor.fxaa(
            postFBO,
            tex,
            this._noaaDrawCount && this._noAaFBO.color[0],
            taaTex,
            this._fxaaAfterTaaDrawCount && this._fxaaFBO && this._fxaaFBO.color[0],
            +(!hasPost && enableAntialias),
            // +!!enableFXAA,
            // 1,
            +!!(config.toneMapping && config.toneMapping.enable),
            +!!(!hasPost && config.sharpen && config.sharpen.enable),
            map.getDevicePixelRatio(),
            sharpFactor,
            enableOutline && this._outlineCounts > 0 && this._getOutlineFBO(),
            highlightFactor,
            outlineFactor,
            outlineWidth,
            outlineColor
        );

        if (postFBO) {
            tex = postFBO.color[0];
        }

        if (enableSSAO) {
            //TODO 合成时，SSAO可能会被fxaaFBO上的像素遮住
            //generate ssao texture for the next frame
            tex = this._postProcessor.ssao(tex, this._depthTex, {
                projMatrix: map.projMatrix,
                cameraNear: map.cameraNear,
                cameraFar: map.cameraFar,
                ssaoBias: config.ssao && config.ssao.bias || 10,
                ssaoRadius: config.ssao && config.ssao.radius || 100,
                ssaoIntensity: config.ssao && config.ssao.intensity || 0.5
            });
        }

        if (enableBloom && this._bloomPainted) {
            const bloomConfig = config.bloom;
            const threshold = +bloomConfig.threshold || 0;
            const factor = getValueOrDefault(bloomConfig, 'factor', 1);
            const radius = getValueOrDefault(bloomConfig, 'radius', 1);
            tex = this._postProcessor.bloom(tex, threshold, factor, radius);
        }

        if (enableSSR) {
            this._postProcessor.genSsrMipmap(tex, this._depthTex);
            if (this._needUpdateSSR) {
                const needRetireFrames = this._needRetireFrames;
                this.setToRedraw();
                this._needRetireFrames = needRetireFrames;
                this._needUpdateSSR = false;
            }
        }

        if (hasPost) {
            this._postProcessor.renderFBOToScreen(tex, +!!(config.sharpen && config.sharpen.enable), sharpFactor, map.getDevicePixelRatio(), enableAntialias);
        }
    }
}


function isNil(obj) {
    return obj == null;
}

function isNumber(val) {
    return (typeof val === 'number') && !isNaN(val);
}

function getFramebuffer(fbo) {
    return fbo['_framebuffer'].framebuffer;
}

function getDepthTexture(fbo) {
    //TODO 也可能是renderbuffer
    return fbo.depthStencil._texture.texture;
}

export default Renderer;


function getValueOrDefault(v, key, defaultValue) {
    if (isNil(v[key])) {
        return defaultValue;
    }
    return v[key];
}
