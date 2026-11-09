// Set dressing for the horde shot. Car drives +Z along x = 0; the action runs z -620 .. -150.
// Each entry: [prop id, x, z, yaw (deg), scale?]. Props listed in OBSTACLE_PROPS block the crowd.
export const PROP_DIRS = {
  crusher: 'r01-crusher', hopper: 'r02-hopper', cabin: 'r03-cabin', screen: 'r04-screen-tower', chute: 'r05-discharge-chute',
  stack: 'r06-dust-stack', conveyor: 'r07-conveyor', headtower: 'r08-head-tower', stacker: 'r09-stacker-head',
  weighbridge: 'k01-weighbridge', office: 'k02-office', workshop: 'k03-workshop', barrier: 'k07-water-barrier', cone: 'k08-cone',
  lego: 'k11-lego-block', signs: 'k12-quarry-signs', reel: 'k13-cable-reel', mast: 'k15-flood-mast', lighttower: 't01-light-tower',
  tipped: 'n06-tipped-haul-truck', drum: 'l16-fuel-drum', tarp: 'k14-tarp-load', skip: 's26-skip', tyres: 't02-tyre-stack',
  excavator: 'q01-excavator', haul: 'q02-haul-truck', dozer: 'q03-bulldozer', loader: 'q04-wheel-loader', dumper: 'q05-dump-truck',
};

let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

export const PLACED = [
  // processing plant, right of the road, where the camera rises
  ['crusher', 46, -330, 90], ['hopper', 30, -328, 0], ['screen', 70, -300, 15], ['headtower', 62, -362, 90],
  ['stacker', 95, -262, -30], ['stack', 52, -288, 0], ['cabin', 38, -350, 180], ['chute', 82, -300, 90],
  ...Array.from({ length: 9 }, (_, k) => ['conveyor', 57 + k * 3, -330, 0]),
  ...Array.from({ length: 8 }, (_, k) => ['conveyor', 76 + k * 2.4, -318 + k * 1.8, -37]),
  // site compound, left of the road where the shot starts
  ['workshop', -48, -505, 0], ['office', -26, -540, 90], ['weighbridge', -17, -470, 0], ['skip', -22, -508, 10], ['skip', -24, -514, 14],
  ['tarp', -30, -520, 30], ['reel', -33, -497, 0], ['reel', -35, -495, 40], ['tyres', -21, -560, 0], ['tyres', -22.4, -561, 0],
  ...Array.from({ length: 6 }, (_, k) => ['drum', -29 + (k % 3) * 0.7, -532 + Math.floor(k / 3) * 0.7, k * 30]),
  ['signs', -9, -600, 90], ['signs', 9, -420, -90], ['signs', -9, -300, 90],
  // machines stranded in the horde
  ['haul', 22, -590, 20], ['excavator', 30, -540, -50], ['loader', -20, -610, 110], ['dozer', 18, -470, 160],
  ['dumper', -26, -420, 70], ['tipped', 17, -385, 200], ['haul', -30, -360, -15], ['excavator', -40, -300, 120],
  ['loader', 24, -250, -80], ['haul', 34, -210, 5], ['dozer', -22, -230, 30], ['dumper', 26, -160, 120],
  ['excavator', 120, -420, 30], ['haul', -110, -380, 60], ['loader', -90, -250, 200], ['haul', 140, -200, -40],
  // road edges: barriers, blocks and cones, with gaps
  ...Array.from({ length: 70 }, (_, k) => {
    const z = -640 + k * 7, side = k % 2 ? 1 : -1;
    if (rnd() < 0.35) return null;
    const kind = rnd() < 0.5 ? 'barrier' : 'lego';
    return [kind, side * (7.6 + rnd() * 0.6), z + rnd() * 3, 90 + (rnd() - 0.5) * 20];
  }).filter(Boolean),
  ...Array.from({ length: 40 }, () => ['cone', (rnd() < 0.5 ? -1 : 1) * (6.6 + rnd() * 1.5), -640 + rnd() * 480, rnd() * 360]),
];
// floodlight masts along the road: each throws a pool of light onto the crowd
export const MASTS = Array.from({ length: 9 }, (_, k) => ({ x: (k % 2 ? 1 : -1) * 13, z: -630 + k * 55 }));
// more masts across the pit, so the crowd shows as lit islands from above
seed = 5;
for (let k = 0; k < 22; k++) MASTS.push({ x: (rnd() < 0.5 ? -1 : 1) * (30 + rnd() * 130), z: -700 + rnd() * 560 });
export const FIELD_MASTS = true;
for (const m of MASTS) PLACED.push(['mast', m.x, m.z, m.x > 0 ? -90 : 90]);

export const OBSTACLE_PROPS = new Set(['crusher', 'hopper', 'cabin', 'screen', 'stack', 'headtower', 'stacker', 'weighbridge', 'office', 'workshop',
  'tipped', 'excavator', 'haul', 'dozer', 'loader', 'dumper', 'skip', 'mast', 'tarp']);

// rocks: big ones on the berms and among the crowd
export const ROCKS = (() => {
  const out = []; seed = 77;
  for (let n = 0; n < 420; n++) {
    const side = rnd() < 0.5 ? -1 : 1, kind = rnd();
    const z = -680 + rnd() * 620;
    const x = kind < 0.5 ? side * (9 + rnd() * 3) : side * (14 + rnd() * 120);
    out.push({ x, z, s: kind < 0.5 ? 0.6 + rnd() * 1.4 : 1 + rnd() * 3, sy: 0.7 + rnd() * 0.6, yaw: rnd() * 6.28, variant: Math.floor(rnd() * 8) });
  }
  return out;
})();
