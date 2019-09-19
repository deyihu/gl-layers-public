import QuadShader from './QuadShader.js';
import vert from './glsl/quad.vert';
import frag from './glsl/fxaa.frag';

class FxaaShader extends QuadShader {
    constructor(viewport) {
        super({
            vert, frag,
            uniforms : ['textureSource', 'resolution'],
            extraCommandProps: {
                viewport
            }
        });
    }

    getMeshCommand(regl, mesh) {
        if (!this.commands['fxaa']) {
            this.commands['fxaa'] = this.createREGLCommand(
                regl,
                null,
                mesh.getAttributes(),
                null,
                mesh.getElements()
            );
        }
        return this.commands['fxaa'];
    }
}

export default FxaaShader;
