import * as reshader from '@maptalks/reshader.gl';
import { vec2 } from 'gl-matrix';

const RESOLUTION = [];

export default class PostProcess {
    constructor(regl, viewport, fbo) {
        this._regl = regl;
        this._target = fbo;
        this._fxaaShader = new reshader.FxaaShader(viewport);
        this._postProcessShader = new reshader.PostProcessShader(viewport);
        this._renderer = new reshader.Renderer(regl);
        this._emptyTexture = regl.texture();

    }

    layer(uniforms, src) {
        const source = src || this._target.color[0];
        if (uniforms['enableSSAO']) {
            const regl = this._regl;
            // this._ssaoTexture = this._ssaoTexture || regl.texture({
            //     width: source.width,
            //     height: source.height,
            //     'min': 'linear',
            //     'mag': 'linear',
            //     'format': 'rgba',
            //     'type': 'uint8'
            // });
            this._ssaoFBO = this._ssaoFBO || regl.framebuffer({
                width: source.width,
                height: source.height,
                // colors: [this._ssaoTexture],
                colorFormat: 'rgba',
                colorCount: 1,
                // depth: true,
                // stencil: true
            });
            if (this._ssaoFBO.width !== source.width ||
                this._ssaoFBO.height !== source.height) {
                this._ssaoFBO.resize(source.width, source.height);
            }
            if (!this._ssaoPass) {
                this._ssaoPass = new reshader.SsaoPass(this._renderer, this._ssaoFBO);
            }
            // regl.clear({
            //     color: EMPTY_COLOR,
            //     depth: 1,
            //     framebuffer: this._ssaoFBO
            // });
            // this._renderer.render(this._ssaoShader, {
            //     projMatrix: uniforms['projMatrix'],
            //     cameraNear: uniforms['cameraNear'],
            //     cameraFar: uniforms['cameraFar'],
            //     resolution: vec2.set(RESOLUTION, source.width, source.height),
            //     'materialParams_depth': this._target.depth,
            //     bias: uniforms['ssaoBias'],
            //     radius: uniforms['ssaoRadius'],
            //     power: uniforms['ssaoPower'],
            // }, null, this._ssaoFBO);
            this._ssaoPass.render({
                projMatrix: uniforms['projMatrix'],
                // cameraNear: uniforms['cameraNear'],
                // cameraFar: uniforms['cameraFar'],
                bias: uniforms['ssaoBias'],
                radius: uniforms['ssaoRadius'],
                power: uniforms['ssaoPower'],
            }, this._target.depth, this._ssaoFBO);
        }
        uniforms['textureSource'] = source;
        uniforms['resolution'] = vec2.set(RESOLUTION, source.width, source.height);
        uniforms['ssaoTexture'] = uniforms['enableSSAO'] ? this._ssaoFBO : this._emptyTexture;
        this._renderer.render(this._fxaaShader, uniforms);
        return this._target;
    }

    //filmic grain + vigenett
    postprocess(uniforms, src) {
        const source = src || this._target.color[0];
        uniforms['resolution'] = vec2.set(RESOLUTION, source.width, source.height);
        uniforms['textureSource'] = source;
        uniforms['timeGrain'] = performance.now();
        this._renderer.render(this._postProcessShader, uniforms);
        return this._target;
    }

    delete() {
        if (this._ssaoTexture) {
            this._ssaoTexture.destroy();
        }
        if (this._ssaoFBO) {
            this._ssaoFBO.destroy();
        }
    }
}
