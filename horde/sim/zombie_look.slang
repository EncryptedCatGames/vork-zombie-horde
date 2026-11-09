// The game's zombie look (tools/blender/creatures kinds.json "look"): repaint by body height,
// keeping the texture's light/dark pattern as detail.
import vork;
import blender.nodes;
struct Inputs {
    Image albedo;
    Image normal_map;
    float3 low_color = float3(.27, .42, .16);   // below `split` (linear)
    float3 high_color = float3(.27, .42, .16);  // above `split`
    float split = .53;
    float detail = .45;
    float detail_average = .28;
    float brightness = 1.;
    Attribute<float> hfrac;                     // 0 at the feet, 1 at the top of the head (rest pose)
};
Closure surface(ShadingContext c, Inputs i) {
    Closure m = {};
    float3 tex = sample(i.albedo, c.TEXCOORD_0, c).rgb;
    float lum = dot(tex, float3(.2126, .7152, .0722));
    float d = clamp(lum / i.detail_average, .35, 1.7);
    d = d * i.detail + (1. - i.detail);
    float h = read_attribute(i.hfrac, c).value;
    float3 col = h < i.split ? i.low_color : i.high_color;
    m.base_color = saturate(col * d * i.brightness);
    m.geometry_normal = Normal_Map(.7, sample(i.normal_map, c.TEXCOORD_0, c).rgb, c);
    m.specular_roughness = .68;
    m.specular_weight = .45;
    return m;
}
