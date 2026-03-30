shader_type spatial;

// Render modes for proper water transparency and depth
render_mode depth_draw_always, depth_prepass_alpha, cull_back;

uniform vec4 albedo : source_color = vec4(0.5, 0.5, 1.0, 0.4); // Pale Light Blue
uniform sampler2D texture_noise : hint_default_white;
uniform float noise_scale = 10.0;
uniform float transparency : hint_range(0.0, 1.0) = 0.9;

void fragment() {
    // Basic color
    vec4 base_color = albedo;
    
    // Add "blotchy" watercolor effect using noise
    float noise = texture(texture_noise, UV * noise_scale).r;
    
    // Mix the base color with the noise to make it look uneven
    ALBEDO = mix(base_color.rgb, vec3(1.0), noise * 0.3); // Mixes in white based on noise
    ALPHA = base_color.a * (1.0 - noise * 0.2); // Faintly varies transparency
    
    // Make it look slightly "soft"
    ROUGHNESS = 0.8;
    METALLIC = 0.0;

    // Add custom logic here (normal maps, depth fade, waves)
}
