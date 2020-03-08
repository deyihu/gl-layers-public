import MeshShader from './MeshShader';
import vert from './glsl/heatmap.vert';
import frag from './glsl/heatmap.frag';
import { mat4 } from 'gl-matrix';
import { extend } from '../common/Util';

class HeatmapShader extends MeshShader {
    constructor(config) {
        const extraCommandProps = config ? config.extraCommandProps || {} : {};
        super({
            vert, frag,
            uniforms: [
                'heatmapRadius', 'heatmapIntensity', 'heatmapWeight', 'extrudeScale',
                {
                    name: 'extrudeScale',
                    type: 'function',
                    fn: function (context, props) {
                        return  props['resolution'] / props['dataResolution'] * props['tileRatio'];
                    }
                },
                {
                    name: 'projViewModelMatrix',
                    type: 'function',
                    fn: function (context, props) {
                        return mat4.multiply([], props['projViewMatrix'], props['modelMatrix']);
                    }
                },
                {
                    name: 'textureOutputSize',
                    type: 'function',
                    fn: function (context) {
                        return [context.drawingBufferWidth, context.drawingBufferHeight];
                    }
                }
            ],
            extraCommandProps: extend({}, extraCommandProps, {
                blend: {
                    enable: true,
                    func: {
                        src: 'one',
                        dst: 'one'
                    },
                    equation: 'add'
                }
            })
        });
    }
}

export default HeatmapShader;