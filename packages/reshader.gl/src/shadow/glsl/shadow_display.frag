precision mediump float;

uniform vec3 color;
uniform float opacity;

#include <vsm_shadow_frag>

void main() {
    float shadow = shadow_computeShadow();
    float alpha = 1.0 - shadow;
	gl_FragColor = vec4(color, opacity * alpha);
}
