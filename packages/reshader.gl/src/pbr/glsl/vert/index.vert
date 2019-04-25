#define SHADER_NAME standard_vertex

    attribute vec3 aPosition;
#ifdef HAS_ATTRIBUTE_TANGENTS
    attribute vec3 aNormal;
#endif
#if defined(MATERIAL_HAS_ANISOTROPY) || defined(MATERIAL_HAS_NORMAL) || defined(MATERIAL_HAS_CLEAR_COAT_NORMAL)
    attribute vec4 aTangent;
#endif
#ifdef HAS_COLOR
    attribute vec3 aColor;
#endif


#if defined(HAS_ATTRIBUTE_UV0)
    attribute vec2 aTexCoord0;
    uniform float uvScale;
    uniform vec2 uvOffset;
#endif
#if defined(HAS_ATTRIBUTE_UV1)
    attribute vec2 aTexCoord1;
#endif

    uniform mat3 normalMatrix;
    uniform mat4 modelMatrix;
    uniform mat4 modelViewMatrix;
    uniform mat4 projViewModelMatrix;

    struct ObjectUniforms {
        mat4 worldFromModelMatrix;
        mat3 worldFromModelNormalMatrix;
    } objectUniforms;

    vec4 computeWorldPosition() {
        return modelMatrix * vec4(aPosition, 1.0);
    }



#include <fl_uniforms_glsl>
#include <fl_inputs_vert>
#include <fl_common_material_vert>

#ifdef HAS_SHADOWING
    #include <vsm_shadow_vert>
#endif

    void initAttributes() {
        mesh_position = vec4(aPosition, 1.0);
        #if defined(MATERIAL_HAS_ANISOTROPY) || defined(MATERIAL_HAS_NORMAL) || defined(MATERIAL_HAS_CLEAR_COAT_NORMAL)
            mesh_tangents = aTangent;
        #endif
        #if defined(HAS_ATTRIBUTE_COLOR)
            mesh_color = vec4(aColor, 1.0);
        #endif
        #if defined(HAS_ATTRIBUTE_UV0)
            mesh_uv0 = (aTexCoord0 + uvOffset) * uvScale;
        #endif
        #if defined(HAS_ATTRIBUTE_UV1)
            mesh_uv1 = aTexCoord1;
        #endif

        //TODO SKINNING的相关属性
        // mesh_bone_indices // vec4
        // mesh_bone_weights // vec4
    }

    void initObjectUniforms() {
        objectUniforms.worldFromModelMatrix = modelMatrix;
        objectUniforms.worldFromModelNormalMatrix = normalMatrix;
    }


    /**
    * Extracts the normal and tangent vectors of the tangent frame encoded in the
    * specified quaternion.
    */
    void toTangentFrame(const highp vec4 q, out highp vec3 n, out highp vec3 t) {
        //TODO 暂时直接读取aNormal和aTangent，而不封装为 quaternion
        //封装后的实现在 common_math.glsl 中
        n = aNormal;
        t = q.xyz;
    }

    void toTangentFrame(const highp vec4 q, out highp vec3 n) {
        //TODO 暂时直接读取aNormal和aTangent，而不封装为 quaternion
        //封装后的实现在 common_math.glsl 中
        n = aNormal;
    }

    void initTangents(inout MaterialVertexInputs material) {
        #if defined(HAS_ATTRIBUTE_TANGENTS)
            // If the material defines a value for the "normal" property, we need to output
            // the full orthonormal basis to apply normal mapping
            #if defined(MATERIAL_HAS_ANISOTROPY) || defined(MATERIAL_HAS_NORMAL) || defined(MATERIAL_HAS_CLEAR_COAT_NORMAL)
                // Extract the normal and tangent in world space from the input quaternion
                // We encode the orthonormal basis as a quaternion to save space in the attributes
                toTangentFrame(mesh_tangents, material.worldNormal, vertex_worldTangent);

                #if defined(HAS_SKINNING)
                    skinNormal(material.worldNormal, mesh_bone_indices, mesh_bone_weights);
                    skinNormal(vertex_worldTangent, mesh_bone_indices, mesh_bone_weights);
                #endif

                // We don't need to normalize here, even if there's a scale in the matrix
                // because we ensure the worldFromModelNormalMatrix pre-scales the normal such that
                // all its components are < 1.0. This precents the bitangent to exceed the range of fp16
                // in the fragment shader, where we renormalize after interpolation
                vertex_worldTangent = objectUniforms.worldFromModelNormalMatrix * vertex_worldTangent;
                material.worldNormal = objectUniforms.worldFromModelNormalMatrix * material.worldNormal;

                // Reconstruct the bitangent from the normal and tangent. We don't bother with
                // normalization here since we'll do it after interpolation in the fragment stage
                vertex_worldBitangent =
                        cross(material.worldNormal, vertex_worldTangent) * sign(mesh_tangents.w);
            #else
                // Without anisotropy or normal mapping we only need the normal vector
                toTangentFrame(mesh_tangents, material.worldNormal);
                material.worldNormal = objectUniforms.worldFromModelNormalMatrix * material.worldNormal;
                #if defined(HAS_SKINNING)
                    skinNormal(material.worldNormal, mesh_bone_indices, mesh_bone_weights);
                #endif
            #endif
        #endif
    }

    void main()
    {
        initFrameUniforms();
        initObjectUniforms();
        initAttributes();
        MaterialVertexInputs material;
        initMaterialVertex(material);
        initTangents(material);

         // Handle built-in interpolated attributes
        #if defined(HAS_ATTRIBUTE_COLOR)
            vertex_color = material.color;
        #endif
        #if defined(HAS_ATTRIBUTE_UV0)
            vertex_uv01.xy = material.uv0;
        #endif
        #if defined(HAS_ATTRIBUTE_UV1)
            vertex_uv01.zw = material.uv1;
        #endif


            // The world position can be changed by the user in materialVertex()
            vertex_worldPosition = material.worldPosition.xyz;
        #ifdef HAS_ATTRIBUTE_TANGENTS
            vertex_worldNormal = material.worldNormal;
        #endif

        // #if defined(HAS_SHADOWING) && defined(HAS_DIRECTIONAL_LIGHTING)
        //     vertex_lightSpacePosition = getLightSpacePosition(vertex_worldPosition, vertex_worldNormal);
        // #endif


        gl_Position =  projViewModelMatrix * mesh_position;

        #ifdef HAS_SHADOWING
            shadow_computeShadowPars(mesh_position);
        #endif
    }

    //------------------------------------------------------------------------------
    // Shadowing
    //------------------------------------------------------------------------------

    // #if defined(HAS_SHADOWING) && defined(HAS_DIRECTIONAL_LIGHTING)
    // /**
    // * Computes the light space position of the specified world space point.
    // * The returned point may contain a bias to attempt to eliminate common
    // * shadowing artifacts such as "acne". To achieve this, the world space
    // * normal at the point must also be passed to this function.
    // */
    // vec4 getLightSpacePosition(const vec3 p, const vec3 n) {
    //     float NoL = saturate(dot(n, frameUniforms.lightDirection));

    // #ifdef TARGET_MOBILE
    //     float normalBias = 1.0 - NoL * NoL;
    // #else
    //     float normalBias = sqrt(1.0 - NoL * NoL);
    // #endif

    //     vec3 offsetPosition = p + n * (normalBias * frameUniforms.shadowBias.y);
    //     vec4 lightSpacePosition = (getLightFromWorldMatrix() * vec4(offsetPosition, 1.0));
    //     lightSpacePosition.z -= frameUniforms.shadowBias.x;

    //     return lightSpacePosition;
    // }
    // #endif

