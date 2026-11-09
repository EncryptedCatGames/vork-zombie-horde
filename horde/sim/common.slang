// Shared constants and helpers for the horde programs (textually included).
static const float GX0 = -700.;      // grid / height field origin (x, z), metres
static const float GZ0 = -1100.;
static const uint  GW = 1400;        // 1 m cells
static const uint  GH = 1400;
static const float HCELL = 2.;       // height field spacing
static const uint  HW = 701;
static const uint  HH = 701;
static const float CAR_Z0 = -720.;   // car path: x = 0, z = CAR_Z0 + CAR_V * t, driving +Z
static const float CAR_V = 28.;
static const float G = 9.81;

uint hash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; return x ^ (x >> 16); }
float rnd(uint x) { return float(hash(x) >> 8) / 16777216.; }

float carZ(float t) { return CAR_Z0 + CAR_V * t; }

float4 qmul(float4 a, float4 b) {
    return float4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
float4 qyaw(float yaw) { return float4(0., sin(yaw * .5), 0., cos(yaw * .5)); }
float4 qaxis(float3 axis, float angle) { return float4(axis * sin(angle * .5), cos(angle * .5)); }
