/** Symmetric & Asymmetric Gamepad 3D Builders:
 * - PlayStation DualSense (symmetric sticks, touchpad, mute, status bar)
 * - Xbox Wireless Controller (asymmetric sticks, hybrid D-pad, ABXY cluster, Xbox Guide)
 * - Nintendo Switch Pro Controller (asymmetric sticks, dark translucent shell, Nintendo ABXY, Home, Capture, +/-)
 *
 * Canonical nodes in all models:
 * Stick_L, Stick_R, Dpad_Group, Dpad_Up, Dpad_Down, Dpad_Left, Dpad_Right,
 * Button_A, Button_B, Button_X, Button_Y, Bumper_LB, Bumper_RB,
 * Trigger_LT, Trigger_RT, Button_Back, Button_Start, Button_Guide, Body
 */
import * as THREE from 'three';

export const GAMEPAD_MODEL_REVISION = 'symmetric-3';

const material = (name, color, roughness, metalness = .04, emissive = 0, emissiveIntensity = 0) =>
  new THREE.MeshStandardMaterial({ name, color, roughness, metalness, emissive, emissiveIntensity });

function outline(draw) {
  const shape = new THREE.Shape();
  draw({
    move: (x, z) => shape.moveTo(x, -z),
    line: (x, z) => shape.lineTo(x, -z),
    curve: (a, b, c, d, x, z) => shape.bezierCurveTo(a, -b, c, -d, x, -z)
  });
  shape.closePath();
  return shape;
}

function roundedFace(shape, depth, bevel = .025, curveSegments = 10) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    curveSegments,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -depth / 2, 0);
  return geometry;
}

function mesh(parent, name, geometry, mat, x = 0, y = 0, z = 0) {
  const part = new THREE.Mesh(geometry, mat);
  part.name = name;
  part.position.set(x, y, z);
  parent.add(part);
  return part;
}

function ring(parent, name, radius, tube, mat, x, y, z) {
  const part = mesh(parent, name, new THREE.TorusGeometry(radius, tube, 12, 48), mat, x, y, z);
  part.rotation.x = Math.PI / 2;
  return part;
}

function stroke(parent, name, points, mat, radius = .009) {
  const path = new THREE.CurvePath();
  for (let i = 1; i < points.length; i++) {
    path.add(new THREE.LineCurve3(new THREE.Vector3(...points[i - 1]), new THREE.Vector3(...points[i])));
  }
  return mesh(parent, name, new THREE.TubeGeometry(path, (points.length - 1) * 4, radius, 6, false), mat);
}

function buildStick(root, body, side, x, y, z, wellMat, socketMat, trimMat, rubberMat, chromeMat, capMat, insetMat) {
  mesh(body, `Stick_${side}_Well`, new THREE.CylinderGeometry(.40, .36, .06, 48), wellMat, x, .242, z);
  ring(body, `Stick_${side}_Socket`, .397, .025, socketMat, x, .264, z);
  ring(body, `Stick_${side}_Trim`, .374, .010, trimMat, x, .268, z);
  const name = `Stick_${side}`;
  const stick = new THREE.Group();
  stick.name = name;
  stick.position.set(x, y, z);
  root.add(stick);
  mesh(stick, `${name}_Ball`, new THREE.SphereGeometry(.245, 24, 16), rubberMat);
  mesh(stick, `${name}_Stem`, new THREE.CylinderGeometry(.055, .07, .16, 16), chromeMat, 0, .13);
  mesh(stick, `${name}_Cap`, new THREE.CylinderGeometry(.32, .29, .09, 48), capMat, 0, .245);
  mesh(stick, `${name}_Dish`, new THREE.CylinderGeometry(.245, .22, .025, 40), insetMat, 0, .275);
  ring(stick, `${name}_Rim`, .268, .021, capMat, 0, .289, 0);
  for (let i = 0; i < 12; i++) {
    const angle = i * Math.PI / 6;
    const groove = mesh(
      stick,
      `${name}_Groove_${i}`,
      new THREE.BoxGeometry(.014, .011, .035),
      rubberMat,
      Math.sin(angle) * .287,
      .29,
      Math.cos(angle) * .287
    );
    groove.rotation.y = angle;
  }
  return stick;
}

function buildDpad(root, x, y, z, insetMat, dpadMat, isFacetedDish = false) {
  const dpad = new THREE.Group();
  dpad.name = 'Dpad_Group';
  dpad.position.set(x, y, z);
  root.add(dpad);
  if (isFacetedDish) {
    const base = mesh(dpad, 'Dpad_Base', new THREE.CylinderGeometry(.40, .43, .025, 8), insetMat, 0, .009);
    base.rotation.y = Math.PI / 8;
  } else {
    const base = mesh(dpad, 'Dpad_Base', new THREE.BoxGeometry(.44, .025, .44), insetMat, 0, .009);
    base.rotation.y = Math.PI / 4;
  }
  const keyShape = outline(({ move, curve, line }) => {
    move(-.08, -.15); line(.08, -.15); curve(.12, -.15, .14, -.12, .14, -.075);
    line(.14, .05); curve(.14, .09, .04, .16, 0, .17); curve(-.04, .16, -.14, .09, -.14, .05);
    line(-.14, -.075); curve(-.14, -.12, -.12, -.15, -.08, -.15);
  });
  const keyGeo = roundedFace(keyShape, .065, .02, 6);
  for (const [name, dx, dz, angle] of [
    ['Up', 0, -.235, 0],
    ['Down', 0, .235, Math.PI],
    ['Left', -.235, 0, Math.PI / 2],
    ['Right', .235, 0, -Math.PI / 2]
  ]) {
    const key = mesh(dpad, `Dpad_${name}`, keyGeo, dpadMat, dx, .075, dz);
    key.rotation.y = angle;
  }
  mesh(dpad, 'Dpad_Center', new THREE.CylinderGeometry(.067, .067, .025, 16), insetMat, 0, .014);
  return dpad;
}

function buildActionButton(root, letter, symbol, x, z, insetMat, buttonMat, glyphMat) {
  const btn = new THREE.Group();
  btn.name = `Button_${letter}`;
  btn.position.set(x, .27, z);
  root.add(btn);
  mesh(btn, `${btn.name}_Rim`, new THREE.CylinderGeometry(.175, .178, .05, 40), insetMat, 0, .015);
  mesh(btn, `${btn.name}_Cap`, new THREE.CylinderGeometry(.155, .164, .075, 40), buttonMat, 0, .056);
  const h = .099;
  const r = .083;
  if (symbol === 'circle') {
    ring(btn, 'Glyph_Circle', r, .008, glyphMat, 0, h, 0);
  } else if (symbol === 'cross') {
    stroke(btn, 'Glyph_Cross_1', [[-r, h, -r], [r, h, r]], glyphMat);
    stroke(btn, 'Glyph_Cross_2', [[-r, h, r], [r, h, -r]], glyphMat);
  } else if (symbol === 'square') {
    stroke(btn, 'Glyph_Square', [[-r, h, -r], [r, h, -r], [r, h, r], [-r, h, r], [-r, h, -r]], glyphMat);
  } else if (symbol === 'triangle') {
    stroke(btn, 'Glyph_Triangle', [[0, h, -r], [r, h, r], [-r, h, r], [0, h, -r]], glyphMat);
  } else if (symbol === 'letterA') {
    stroke(btn, 'Glyph_A_Legs', [[-r * .7, h, r * .8], [0, h, -r * .8], [r * .7, h, r * .8]], glyphMat);
    stroke(btn, 'Glyph_A_Bar', [[-r * .42, h, r * .15], [r * .42, h, r * .15]], glyphMat);
  } else if (symbol === 'letterB') {
    stroke(btn, 'Glyph_B_Spine', [[-r * .55, h, -r * .75], [-r * .55, h, r * .75]], glyphMat);
    stroke(btn, 'Glyph_B_Top', [[-r * .55, h, -r * .75], [r * .32, h, -r * .75], [r * .48, h, -r * .38], [r * .32, h, 0], [-r * .55, h, 0]], glyphMat);
    stroke(btn, 'Glyph_B_Btm', [[-r * .55, h, 0], [r * .38, h, 0], [r * .52, h, r * .38], [r * .38, h, r * .75], [-r * .55, h, r * .75]], glyphMat);
  } else if (symbol === 'letterX') {
    stroke(btn, 'Glyph_X_1', [[-r * .65, h, -r * .7], [r * .65, h, r * .7]], glyphMat);
    stroke(btn, 'Glyph_X_2', [[-r * .65, h, r * .7], [r * .65, h, -r * .7]], glyphMat);
  } else if (symbol === 'letterY') {
    stroke(btn, 'Glyph_Y_Fork', [[-r * .65, h, -r * .75], [0, h, 0], [r * .65, h, -r * .75]], glyphMat);
    stroke(btn, 'Glyph_Y_Stem', [[0, h, 0], [0, h, r * .75]], glyphMat);
  }
  return btn;
}

function buildShoulders(root, bumperMatL, bumperMatR, triggerMatL, triggerMatR, xOffset = 1.42, yBumper = .13, zBumper = -1.015, yTrigger = -.045, zTrigger = -1.05) {
  for (const [side, sign] of [['L', -1], ['R', 1]]) {
    const bMat = side === 'L' ? bumperMatL : bumperMatR;
    const shoulder = mesh(root, `Bumper_${side === 'L' ? 'LB' : 'RB'}`, new THREE.CapsuleGeometry(.09, .52, 8, 24), bMat, sign * xOffset, yBumper, zBumper);
    shoulder.rotation.set(0, 0, Math.PI / 2);
    const trigger = new THREE.Group();
    trigger.name = `Trigger_${side === 'L' ? 'LT' : 'RT'}`;
    trigger.position.set(sign * (xOffset + .04), yTrigger, zTrigger);
    root.add(trigger);
    const tMat = side === 'L' ? triggerMatL : triggerMatR;
    const blade = mesh(trigger, `${trigger.name}_Blade`, new THREE.BoxGeometry(.43, .22, .24), tMat, 0, -.10, -.04);
    blade.rotation.x = -.20;
  }
}

function buildGrips(body, rubberMat, xSign = 1.76, y = -.15, z = 1.05, rearX = 1.64, rearY = -.25, rearZ = 1.09) {
  for (const [side, sign] of [['L', -1], ['R', 1]]) {
    const pad = mesh(body, `Grip_${side}`, new THREE.CapsuleGeometry(.19, .79, 8, 16), rubberMat, sign * xSign, y, z);
    pad.rotation.set(Math.PI / 2, 0, -sign * .24);
    const rear = mesh(body, `Rear_Grip_${side}`, new THREE.CapsuleGeometry(.15, .66, 8, 16), rubberMat, sign * rearX, rearY, rearZ);
    rear.rotation.set(Math.PI / 2, 0, -sign * .28);
  }
}

/** PlayStation DualSense style (symmetric sticks, central touchpad, status light) */
export function createPlayStationGamepadModel() {
  const root = new THREE.Group();
  root.name = 'GamepadRoot';
  root.userData.modelRevision = GAMEPAD_MODEL_REVISION;
  root.userData.gamepadType = 'playstation';

  const white = material('Mat_GamepadBody', 0xe6e8ed, .48, .03);
  const touchpad = material('Mat_Touchpad', 0xd2d5dc, .58, .02);
  const inset = material('Mat_CenterFace', 0x242831, .58, .05);
  const rubber = material('Mat_Grip', 0x181b22, .90);
  const chrome = material('Mat_Chrome', 0x7a8597, .25, .96);
  const well = material('Mat_StickWell', 0x11151c, .76);
  const cap = material('Mat_StickRubber', 0x272b34, .80);
  const dpadMat = material('Mat_Dpad', 0x414753, .48, .12);
  const glyph = material('Mat_ButtonGlyph', 0x6c7b94, .48, .05);

  const body = new THREE.Group();
  body.name = 'Body';
  root.add(body);

  const shellShape = outline(({ move, curve }) => {
    move(0, -.97);
    curve(.50, -.97, .93, -.98, 1.27, -.91);
    curve(1.62, -1.07, 1.93, -.94, 2.02, -.52);
    curve(2.20, .12, 2.23, .98, 2.06, 1.59);
    curve(1.97, 1.93, 1.67, 1.98, 1.49, 1.68);
    curve(1.29, 1.35, 1.19, .98, .98, .88);
    curve(.77, .77, .30, .81, 0, .81);
    curve(-.30, .81, -.77, .77, -.98, .88);
    curve(-1.19, .98, -1.29, 1.35, -1.49, 1.68);
    curve(-1.67, 1.98, -1.97, 1.93, -2.06, 1.59);
    curve(-2.23, .98, -2.20, .12, -2.02, -.52);
    curve(-1.93, -.94, -1.62, -1.07, -1.27, -.91);
    curve(-.93, -.98, -.50, -.97, 0, -.97);
  });
  const shellGeo = roundedFace(shellShape, .27, .075);
  const vertices = shellGeo.attributes.position;
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i), z = vertices.getZ(i);
    vertices.setY(i, vertices.getY(i) + .017 * Math.max(0, 1 - (x * x + .3 * z * z) / 5));
  }
  shellGeo.computeVertexNormals();
  mesh(body, 'Body_Shell', shellGeo, white);

  const lower = mesh(body, 'Body_LowerShell', roundedFace(shellShape, .22, .065), rubber, 0, -.15);
  lower.scale.set(.985, 1, .985);

  const insertShape = outline(({ move, curve, line }) => {
    move(-.94, -.91); line(.94, -.91);
    curve(1.08, -.88, 1.00, -.40, 1.12, -.06);
    curve(1.29, .29, 1.32, .71, 1.08, .87);
    curve(.80, .75, .24, .73, 0, .74);
    curve(-.24, .73, -.80, .75, -1.08, .87);
    curve(-1.32, .71, -1.29, .29, -1.12, -.06);
    curve(-1.00, -.40, -1.08, -.88, -.94, -.91);
  });
  mesh(body, 'Center_Insert', roundedFace(insertShape, .035, .018), inset, 0, .22);

  const panelShape = outline(({ move, curve, line }) => {
    move(-.78, -.91); line(.78, -.91);
    curve(.94, -.91, 1.00, -.84, .97, -.66);
    line(.87, -.12); curve(.85, .01, .77, .055, .63, .055);
    line(-.63, .055); curve(-.77, .055, -.85, .01, -.87, -.12);
    line(-.97, -.66); curve(-1.00, -.84, -.94, -.91, -.78, -.91);
  });
  mesh(body, 'Center_Plate', roundedFace(panelShape, .035, .035), touchpad, 0, .26);

  const led = material('Mat_StatusLight', 0x719dd7, .42, .05, 0x4076b5, .25);
  mesh(body, 'Status_Light', new THREE.BoxGeometry(1.18, .014, .022), led, 0, .264, .105);
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 5 - row; column++) {
      mesh(
        body,
        `Speaker_${row}_${column}`,
        new THREE.CylinderGeometry(.018, .018, .008, 12),
        well,
        (column - (4 - row) / 2) * .075,
        .258,
        .22 + row * .055
      );
    }
  }
  mesh(body, 'Mute_Button', new THREE.BoxGeometry(.18, .025, .043), inset, 0, .225, .68);
  buildGrips(body, rubber, 1.76, -.15, 1.05, 1.64, -.25, 1.09);

  // Analógicos simétricos na base inferior
  const stickX = .72, stickZ = .47;
  for (const [side, sign] of [['L', -1], ['R', 1]]) {
    buildStick(root, body, side, sign * stickX, .255, stickZ, well, inset, chrome, rubber, chrome, cap, inset);
  }

  // D-Pad superior esquerdo
  buildDpad(root, -1.43, .25, -.30, inset, dpadMat, false);

  // Cluster de botões superior direito
  const centerX = 1.48, centerZ = -.30, spacing = .32;
  for (const [letter, symbol, x, z] of [
    ['A', 'cross', centerX, centerZ + spacing],
    ['B', 'circle', centerX + spacing, centerZ],
    ['X', 'square', centerX - spacing, centerZ],
    ['Y', 'triangle', centerX, centerZ - spacing]
  ]) {
    const buttonMat = material(`Mat_Button${letter}`, 0xb9c2d1, .32, .04, 0x435c83, .05);
    buildActionButton(root, letter, symbol, x, z, inset, buttonMat, glyph);
  }

  for (const [name, sign] of [['Back', -1], ['Start', 1]]) {
    const mat = material(`Mat_Button${name}`, 0x676f7b, .46, .05);
    const key = mesh(root, `Button_${name}`, new THREE.CapsuleGeometry(.038, .115, 8, 16), mat, sign * 1.10, .31, -.67);
    key.rotation.x = Math.PI / 2;
  }

  const guide = new THREE.Group();
  guide.name = 'Button_Guide';
  guide.position.set(0, .29, .47);
  root.add(guide);
  const guideMat = material('Mat_GuideGlow', 0x4d5b70, .48, .05, 0x365b8b, .6);
  const guideRingMat = material('Mat_GuideRing', 0x45658a, .46, .05, 0x24405f, .20);
  mesh(guide, 'Button_Guide_Disc', new THREE.CylinderGeometry(.105, .115, .055, 32), guideMat, 0, .036);
  ring(guide, 'Button_Guide_Ring', .116, .012, guideRingMat, 0, .056, 0);

  const bumperMatL = material('Mat_BumperLB', 0x303640, .42, .12);
  const bumperMatR = material('Mat_BumperRB', 0x303640, .42, .12);
  const triggerMatL = material('Mat_Trigger_LT', 0x292e38, .43, .16);
  const triggerMatR = material('Mat_Trigger_RT', 0x292e38, .43, .16);
  buildShoulders(root, bumperMatL, bumperMatR, triggerMatL, triggerMatR, 1.42, .13, -1.015, -.045, -1.05);

  return root;
}

/** Xbox Wireless Controller (asymmetric sticks, hybrid D-pad, ABXY cluster, Xbox Guide) */
export function createXboxGamepadModel() {
  const root = new THREE.Group();
  root.name = 'GamepadRoot';
  root.userData.modelRevision = GAMEPAD_MODEL_REVISION;
  root.userData.gamepadType = 'xbox';

  const white = material('Mat_GamepadBody', 0xf0f2f5, .45, .03);
  const darkFace = material('Mat_CenterFace', 0x22252c, .55, .06);
  const rubber = material('Mat_Grip', 0x1b1d22, .88);
  const chrome = material('Mat_Chrome', 0x8892a0, .22, .95);
  const well = material('Mat_StickWell', 0x14161b, .76);
  const cap = material('Mat_StickRubber', 0x23272e, .82);
  const dpadMat = material('Mat_Dpad', 0x2e323b, .40, .18);

  // Materiais ABXY com cores características de identificação Xbox
  const btnMatA = material('Mat_ButtonA', 0x242830, .35, .05, 0x107c10, .25);
  const btnMatB = material('Mat_ButtonB', 0x242830, .35, .05, 0xd83b01, .25);
  const btnMatX = material('Mat_ButtonX', 0x242830, .35, .05, 0x0078d4, .25);
  const btnMatY = material('Mat_ButtonY', 0x242830, .35, .05, 0xffb900, .25);
  const glyphA = material('Mat_GlyphA', 0x22c55e, .30, .10, 0x22c55e, .7);
  const glyphB = material('Mat_GlyphB', 0xef4444, .30, .10, 0xef4444, .7);
  const glyphX = material('Mat_GlyphX', 0x3b82f6, .30, .10, 0x3b82f6, .7);
  const glyphY = material('Mat_GlyphY', 0xeab308, .30, .10, 0xeab308, .7);

  const body = new THREE.Group();
  body.name = 'Body';
  root.add(body);

  const shellShape = outline(({ move, curve }) => {
    move(0, -.95);
    curve(.48, -.95, .90, -.96, 1.25, -.88);
    curve(1.58, -1.02, 1.88, -.90, 1.98, -.50);
    curve(2.15, .10, 2.18, .92, 2.02, 1.55);
    curve(1.92, 1.88, 1.62, 1.94, 1.45, 1.65);
    curve(1.25, 1.32, 1.15, .95, .94, .85);
    curve(.72, .75, .28, .78, 0, .78);
    curve(-.28, .78, -.72, .75, -.94, .85);
    curve(-1.15, .95, -1.25, 1.32, -1.45, 1.65);
    curve(-1.62, 1.94, -1.92, 1.88, -2.02, 1.55);
    curve(-2.18, .92, -2.15, .10, -1.98, -.50);
    curve(-1.88, -.90, -1.58, -1.02, -1.25, -.88);
    curve(-.90, -.96, -.48, -.95, 0, -.95);
  });
  const shellGeo = roundedFace(shellShape, .27, .075);
  const vertices = shellGeo.attributes.position;
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i), z = vertices.getZ(i);
    vertices.setY(i, vertices.getY(i) + .018 * Math.max(0, 1 - (x * x + .35 * z * z) / 5));
  }
  shellGeo.computeVertexNormals();
  mesh(body, 'Body_Shell', shellGeo, white);

  const lower = mesh(body, 'Body_LowerShell', roundedFace(shellShape, .22, .065), rubber, 0, -.15);
  lower.scale.set(.985, 1, .985);

  const cowlShape = outline(({ move, curve, line }) => {
    move(-.60, -.94); line(.60, -.94);
    curve(.78, -.94, .82, -.80, .74, -.55);
    line(.48, -.32); curve(.32, -.24, -.32, -.24, -.48, -.32);
    line(-.74, -.55); curve(-.82, -.80, -.78, -.94, -.60, -.94);
  });
  mesh(body, 'Center_Plate', roundedFace(cowlShape, .035, .025), darkFace, 0, .26);

  buildGrips(body, rubber, 1.74, -.15, 1.02, 1.62, -.25, 1.06);

  // Disposição assimétrica: Analógico L superior esquerdo
  buildStick(root, body, 'L', -1.15, .255, -.32, well, darkFace, chrome, rubber, chrome, cap, darkFace);

  // Analógico R inferior direito
  buildStick(root, body, 'R', 0.72, .255, .42, well, darkFace, chrome, rubber, chrome, cap, darkFace);

  // D-Pad híbrido multifacetado inferior esquerdo
  buildDpad(root, -0.72, .25, .42, darkFace, dpadMat, true);

  // Cluster de botões ABXY superior direito
  const centerX = 1.35, centerZ = -.32, spacing = .31;
  buildActionButton(root, 'A', 'letterA', centerX, centerZ + spacing, darkFace, btnMatA, glyphA);
  buildActionButton(root, 'B', 'letterB', centerX + spacing, centerZ, darkFace, btnMatB, glyphB);
  buildActionButton(root, 'X', 'letterX', centerX - spacing, centerZ, darkFace, btnMatX, glyphX);
  buildActionButton(root, 'Y', 'letterY', centerX, centerZ - spacing, darkFace, btnMatY, glyphY);

  // Botões de navegação (View / Menu / Share)
  const navMat = material('Mat_ButtonNav', 0x3e4450, .45, .05);
  const backBtn = mesh(root, 'Button_Back', new THREE.CapsuleGeometry(.035, .08, 8, 16), navMat, -0.45, .31, -.32);
  backBtn.rotation.x = Math.PI / 2;
  const startBtn = mesh(root, 'Button_Start', new THREE.CapsuleGeometry(.035, .08, 8, 16), navMat, 0.45, .31, -.32);
  startBtn.rotation.x = Math.PI / 2;

  // Botão central Xbox Guide (Nexus com logo iluminado)
  const guide = new THREE.Group();
  guide.name = 'Button_Guide';
  guide.position.set(0, .29, -.52);
  root.add(guide);
  const guideMat = material('Mat_GuideGlow', 0xf0f2f5, .30, .05, 0xffffff, .8);
  const guideRingMat = material('Mat_GuideRing', 0x2a2e36, .45, .10, 0xffffff, .20);
  mesh(guide, 'Button_Guide_Disc', new THREE.CylinderGeometry(.125, .135, .055, 32), guideMat, 0, .036);
  ring(guide, 'Button_Guide_Ring', .138, .012, guideRingMat, 0, .056, 0);

  // Logo X característico estilizado do botão Xbox
  const xG = material('Mat_XboxLogo', 0x111317, .40, .10);
  stroke(guide, 'Xbox_Logo_L', [[-.06, .068, -.05], [0, .068, .04], [.06, .068, -.05]], xG, .008);
  stroke(guide, 'Xbox_Logo_R', [[-.05, .068, .04], [0, .068, -.03], [.05, .068, .04]], xG, .008);

  // Botão de captura / Share central
  mesh(body, 'Button_Share', new THREE.CylinderGeometry(.045, .048, .03, 16), darkFace, 0, .26, .05);

  const bumperMatL = material('Mat_BumperLB', 0x282c35, .38, .12);
  const bumperMatR = material('Mat_BumperRB', 0x282c35, .38, .12);
  const triggerMatL = material('Mat_Trigger_LT', 0x20232b, .42, .16);
  const triggerMatR = material('Mat_Trigger_RT', 0x20232b, .42, .16);
  buildShoulders(root, bumperMatL, bumperMatR, triggerMatL, triggerMatR, 1.40, .14, -1.02, -.045, -1.05);

  return root;
}

/** Nintendo Switch Pro Controller (asymmetric sticks, dark translucent body, Nintendo glyphs, Home, Capture, +/-) */
export function createSwitchGamepadModel() {
  const root = new THREE.Group();
  root.name = 'GamepadRoot';
  root.userData.modelRevision = GAMEPAD_MODEL_REVISION;
  root.userData.gamepadType = 'nintendo';

  const bodyMat = material('Mat_GamepadBody', 0x22262e, .40, .06);
  const pcbMat = material('Mat_CenterFace', 0x1a2420, .65, .08);
  const rubber = material('Mat_Grip', 0x181a20, .85, .04);
  const chrome = material('Mat_Chrome', 0x8892a0, .22, .95);
  const well = material('Mat_StickWell', 0x121418, .76);
  const cap = material('Mat_StickRubber', 0x2a2d35, .82);
  const dpadMat = material('Mat_Dpad', 0x2e323b, .45, .08);

  // Botões de ação Nintendo
  const btnMatA = material('Mat_ButtonA', 0x252830, .28, .04, 0x48556a, .15);
  const btnMatB = material('Mat_ButtonB', 0x252830, .28, .04, 0x48556a, .15);
  const btnMatX = material('Mat_ButtonX', 0x252830, .28, .04, 0x48556a, .15);
  const btnMatY = material('Mat_ButtonY', 0x252830, .28, .04, 0x48556a, .15);
  const glyphMat = material('Mat_ButtonGlyph', 0xd0d5dd, .40, .05);

  const body = new THREE.Group();
  body.name = 'Body';
  root.add(body);

  const switchShape = outline(({ move, curve }) => {
    move(0, -.92);
    curve(.48, -.92, .88, -.93, 1.22, -.86);
    curve(1.54, -.98, 1.84, -.86, 1.94, -.48);
    curve(2.12, .12, 2.14, .92, 1.98, 1.52);
    curve(1.88, 1.84, 1.60, 1.90, 1.42, 1.62);
    curve(1.24, 1.30, 1.14, .95, .92, .85);
    curve(.72, .76, .28, .80, 0, .80);
    curve(-.28, .80, -.72, .76, -.92, .85);
    curve(-1.14, .95, -1.24, 1.30, -1.42, 1.62);
    curve(-1.60, 1.90, -1.88, 1.84, -1.98, 1.52);
    curve(-2.14, .92, -2.12, .12, -1.94, -.48);
    curve(-1.84, -.86, -1.54, -.98, -1.22, -.86);
    curve(-.88, -.93, -.48, -.92, 0, -.92);
  });
  const shellGeo = roundedFace(switchShape, .27, .075);
  const vertices = shellGeo.attributes.position;
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i), z = vertices.getZ(i);
    vertices.setY(i, vertices.getY(i) + .016 * Math.max(0, 1 - (x * x + .32 * z * z) / 5));
  }
  shellGeo.computeVertexNormals();
  mesh(body, 'Body_Shell', shellGeo, bodyMat);

  const lower = mesh(body, 'Body_LowerShell', roundedFace(switchShape, .22, .065), rubber, 0, -.15);
  lower.scale.set(.985, 1, .985);

  // Placa interna decorativa visível através da carcaça translúcida
  const pcbShape = outline(({ move, curve, line }) => {
    move(-.70, -.85); line(.70, -.85);
    curve(.90, -.85, .95, -.50, .80, -.15);
    line(.55, .45); curve(.40, .60, -.40, .60, -.55, .45);
    line(-.80, -.15); curve(-.95, -.50, -.90, -.85, -.70, -.85);
  });
  mesh(body, 'Center_Plate', roundedFace(pcbShape, .035, .02), pcbMat, 0, .22);

  buildGrips(body, rubber, 1.72, -.15, 1.02, 1.60, -.25, 1.06);

  // LEDs indicadores de jogador na borda frontal inferior
  const ledMat = material('Mat_PlayerLED', 0x10b981, .3, .1, 0x10b981, .9);
  for (let i = 0; i < 4; i++) {
    mesh(body, `LED_${i}`, new THREE.CylinderGeometry(.02, .02, .015, 12), ledMat, (i - 1.5) * .12, .24, .82);
  }

  // Disposição assimétrica: Analógico L superior esquerdo
  buildStick(root, body, 'L', -1.15, .255, -.28, well, pcbMat, chrome, rubber, chrome, cap, pcbMat);

  // Analógico R inferior direito
  buildStick(root, body, 'R', 0.72, .255, .38, well, pcbMat, chrome, rubber, chrome, cap, pcbMat);

  // D-Pad canônico Nintendo em cruz clássica
  buildDpad(root, -0.72, .25, .38, pcbMat, dpadMat, false);

  // Cluster de botões frontais: layout canônico com identificação visual Nintendo
  // Standard Gamepad API: 0 = Bottom (Nintendo B), 1 = Right (Nintendo A), 2 = Left (Nintendo Y), 3 = Top (Nintendo X)
  const centerX = 1.32, centerZ = -.28, spacing = .32;
  buildActionButton(root, 'A', 'letterB', centerX, centerZ + spacing, pcbMat, btnMatA, glyphMat);
  buildActionButton(root, 'B', 'letterA', centerX + spacing, centerZ, pcbMat, btnMatB, glyphMat);
  buildActionButton(root, 'X', 'letterY', centerX - spacing, centerZ, pcbMat, btnMatX, glyphMat);
  buildActionButton(root, 'Y', 'letterX', centerX, centerZ - spacing, pcbMat, btnMatY, glyphMat);

  // Botões de sistema Nintendo: Menos (-) e Mais (+)
  const navMat = material('Mat_ButtonNav', 0x2e333d, .40, .05);
  const minus = new THREE.Group();
  minus.name = 'Button_Back';
  minus.position.set(-0.48, .30, -.38);
  root.add(minus);
  mesh(minus, 'Button_Back_Cap', new THREE.CylinderGeometry(.065, .07, .04, 24), navMat, 0, 0, 0);
  stroke(minus, 'Minus_Glyph', [[-0.032, .025, 0], [0.032, .025, 0]], glyphMat);

  const plus = new THREE.Group();
  plus.name = 'Button_Start';
  plus.position.set(0.48, .30, -.38);
  root.add(plus);
  mesh(plus, 'Button_Start_Cap', new THREE.CylinderGeometry(.065, .07, .04, 24), navMat, 0, 0, 0);
  stroke(plus, 'Plus_Glyph_H', [[-0.032, .025, 0], [0.032, .025, 0]], glyphMat);
  stroke(plus, 'Plus_Glyph_V', [[0, .025, -0.032], [0, .025, 0.032]], glyphMat);

  // Botão Capture (lado esquerdo inferior)
  const capture = new THREE.Group();
  capture.name = 'Button_Capture';
  capture.position.set(-0.36, .28, -.12);
  root.add(capture);
  mesh(capture, 'Capture_Cap', new THREE.CylinderGeometry(.065, .07, .035, 24), navMat, 0, 0, 0);
  stroke(capture, 'Capture_Square', [
    [-.025, .022, -.025],
    [.025, .022, -.025],
    [.025, .022, .025],
    [-.025, .022, .025],
    [-.025, .022, -.025]
  ], glyphMat, .006);

  // Botão Home com halo de luz azul iluminado (Button_Guide canônico)
  const guide = new THREE.Group();
  guide.name = 'Button_Guide';
  guide.position.set(0.36, .28, -.12);
  root.add(guide);
  const homeMat = material('Mat_GuideGlow', 0x22262e, .35, .05, 0x0078d4, .6);
  const homeRingMat = material('Mat_GuideRing', 0x0078d4, .30, .10, 0x0078d4, .8);
  mesh(guide, 'Button_Guide_Disc', new THREE.CylinderGeometry(.105, .115, .055, 32), homeMat, 0, .036);
  ring(guide, 'Button_Guide_Ring', .116, .012, homeRingMat, 0, .056, 0);

  // Ícone característico de casinha do Home
  stroke(guide, 'Home_Roof', [[-0.045, .068, 0.01], [0, .068, -0.045], [0.045, .068, 0.01]], glyphMat, .007);
  stroke(guide, 'Home_Walls', [[-0.035, .068, 0.01], [-0.035, .068, 0.045], [0.035, .068, 0.045], [0.035, .068, 0.01]], glyphMat, .007);

  const bumperMatL = material('Mat_BumperLB', 0x242830, .40, .10);
  const bumperMatR = material('Mat_BumperRB', 0x242830, .40, .10);
  const triggerMatL = material('Mat_Trigger_LT', 0x1e2128, .42, .14);
  const triggerMatR = material('Mat_Trigger_RT', 0x1e2128, .42, .14);
  buildShoulders(root, bumperMatL, bumperMatR, triggerMatL, triggerMatR, 1.38, .14, -1.00, -.045, -1.04);

  return root;
}

export const createNintendoGamepadModel = createSwitchGamepadModel;

/** Fábrica unificada: seleciona o modelo adequado conforme o tipo detectado */
export function createGamepadModel(type = 'playstation') {
  const norm = String(type || '').toLowerCase().trim();
  if (norm === 'xbox') return createXboxGamepadModel();
  if (norm === 'nintendo' || norm === 'switch') return createSwitchGamepadModel();
  return createPlayStationGamepadModel();
}

/** Retorna a URL canônica do asset GLB correspondente ao tipo de controle */
export function getGamepadModelUrl(type = 'playstation') {
  const norm = String(type || '').toLowerCase().trim();
  if (norm === 'xbox' || norm === 'xinput') return `css/assets/gamepad-xbox.glb?v=${GAMEPAD_MODEL_REVISION}`;
  if (norm === 'nintendo' || norm === 'switch') return `css/assets/gamepad-switch.glb?v=${GAMEPAD_MODEL_REVISION}`;
  return `css/assets/gamepad.glb?v=${GAMEPAD_MODEL_REVISION}`;
}

