/**
 * SeeMyGame - Gamepad 3D Model Builder (Ergonomic PBR Geometry)
 * Constrói a geometria tridimensional realista e anatômica do controle gamer.
 * 
 * Orientação:
 *  +X: Lado direito (ABXY, Stick R, Grip R, RB, RT)
 *  -X: Lado esquerdo (Stick L, D-Pad, Grip L, LB, LT)
 *  +Y: Face superior voltada para o jogador (Botões, analógicos, logo)
 *  -Y: Parte inferior / fundo do controle
 *  +Z: Borda inferior / empunhaduras voltadas para o usuário
 *  -Z: Borda superior / gatilhos e bumpers voltados para frente
 */

import * as THREE from 'three';

export function createGamepadModel() {
  const root = new THREE.Group();
  root.name = 'GamepadRoot';

  // ==========================================
  // 1. Materiais PBR Gamer de Alta Fidelidade
  // ==========================================

  // Carcaça principal: acabamento grafite acetinado de alta visibilidade
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x30364a,
    roughness: 0.35,
    metalness: 0.22,
    name: 'Mat_GamepadBody'
  });

  // Placa central / Touchpad: acabamento preto fosco premium
  const centerFaceMaterial = new THREE.MeshStandardMaterial({
    color: 0x1d212d,
    roughness: 0.50,
    metalness: 0.18,
    name: 'Mat_CenterFace'
  });

  // Manoplas de aderência (Rubber Grips): borracha texturizada escura
  const gripMaterial = new THREE.MeshStandardMaterial({
    color: 0x181a24,
    roughness: 0.80,
    metalness: 0.08,
    name: 'Mat_Grip'
  });

  // Hastes dos analógicos e aros: metal cromado reflexivo
  const chromeMaterial = new THREE.MeshStandardMaterial({
    color: 0xdde2ec,
    metalness: 0.95,
    roughness: 0.10,
    name: 'Mat_Chrome'
  });

  // Cabeça dos analógicos: borracha antiderrapante
  const stickRubberMaterial = new THREE.MeshStandardMaterial({
    color: 0x222634,
    roughness: 0.70,
    metalness: 0.12,
    name: 'Mat_StickRubber'
  });

  // D-Pad direcional: acabamento metálico gunmetal
  const dpadMaterial = new THREE.MeshStandardMaterial({
    color: 0x3e455c,
    metalness: 0.65,
    roughness: 0.30,
    name: 'Mat_Dpad'
  });

  // Bumpers e Gatilhos: acabamento escovado escuro
  const shoulderMaterial = new THREE.MeshStandardMaterial({
    color: 0x262b3a,
    roughness: 0.32,
    metalness: 0.45,
    name: 'Mat_Shoulder'
  });

  // Botões de Ação ABXY com material brilhante e emissivo para feedback
  const btnAMaterial = new THREE.MeshStandardMaterial({
    color: 0x10b981,
    emissive: 0x065f46,
    emissiveIntensity: 0.55,
    roughness: 0.18,
    metalness: 0.15,
    name: 'Mat_ButtonA'
  });

  const btnBMaterial = new THREE.MeshStandardMaterial({
    color: 0xef4444,
    emissive: 0x991b1b,
    emissiveIntensity: 0.55,
    roughness: 0.18,
    metalness: 0.15,
    name: 'Mat_ButtonB'
  });

  const btnXMaterial = new THREE.MeshStandardMaterial({
    color: 0x3b82f6,
    emissive: 0x1e40af,
    emissiveIntensity: 0.55,
    roughness: 0.18,
    metalness: 0.15,
    name: 'Mat_ButtonX'
  });

  const btnYMaterial = new THREE.MeshStandardMaterial({
    color: 0xf59e0b,
    emissive: 0x92400e,
    emissiveIntensity: 0.55,
    roughness: 0.18,
    metalness: 0.15,
    name: 'Mat_ButtonY'
  });

  // Botão Guide / Nexus com LED central radiante
  const guideGlowMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x8b5cf6,
    emissiveIntensity: 0.95,
    roughness: 0.08,
    metalness: 0.2,
    name: 'Mat_GuideGlow'
  });

  // ==========================================
  // 2. Chassi Anatômico Esculpido por Extrusão Bézier (Body)
  // ==========================================
  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'Body';

  const shape = new THREE.Shape();
  // Curvas paramétricas contínuas da silhueta ergonômica
  shape.moveTo(0, 0.72);
  shape.bezierCurveTo(0.45, 0.72, 0.85, 0.68, 1.25, 0.58);
  shape.bezierCurveTo(1.65, 0.48, 1.95, 0.25, 1.98, -0.15);
  shape.bezierCurveTo(2.00, -0.55, 1.75, -1.05, 1.45, -1.35);
  shape.bezierCurveTo(1.25, -1.55, 0.95, -1.45, 0.82, -1.15);
  shape.bezierCurveTo(0.70, -0.85, 0.62, -0.45, 0.45, -0.32);
  shape.bezierCurveTo(0.25, -0.22, -0.25, -0.22, -0.45, -0.32);
  shape.bezierCurveTo(-0.62, -0.45, -0.70, -0.85, -0.82, -1.15);
  shape.bezierCurveTo(-0.95, -1.45, -1.25, -1.55, -1.45, -1.35);
  shape.bezierCurveTo(-1.75, -1.05, -2.00, -0.55, -1.98, -0.15);
  shape.bezierCurveTo(-1.95, 0.25, -1.65, 0.48, -1.25, 0.58);
  shape.bezierCurveTo(-0.85, 0.68, -0.45, 0.72, 0, 0.72);

  const extrudeSettings = {
    steps: 1,
    depth: 0.35,
    bevelEnabled: true,
    bevelThickness: 0.16,
    bevelSize: 0.14,
    bevelOffset: 0,
    bevelSegments: 8
  };

  const bodyShellGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  // Alinha a extrusão para que a face do controle aponte para +Y
  bodyShellGeo.rotateX(-Math.PI / 2);
  bodyShellGeo.center();

  const bodyShellMesh = new THREE.Mesh(bodyShellGeo, bodyMaterial);
  bodyShellMesh.position.set(0, 0, 0.1);
  bodyGroup.add(bodyShellMesh);

  // Placa central / Touchpad esculpido
  const centerPlateGeo = new THREE.BoxGeometry(1.10, 0.06, 0.75);
  const centerPlate = new THREE.Mesh(centerPlateGeo, centerFaceMaterial);
  centerPlate.position.set(0, 0.22, 0.02);
  bodyGroup.add(centerPlate);

  // Barra de LED decorativa estilo Gamer / DualSense
  const ledBarGeo = new THREE.BoxGeometry(0.75, 0.03, 0.04);
  const ledBarMat = new THREE.MeshStandardMaterial({
    color: 0x06b6d4,
    emissive: 0x06b6d4,
    emissiveIntensity: 1.4
  });
  const ledBar = new THREE.Mesh(ledBarGeo, ledBarMat);
  ledBar.position.set(0, 0.26, -0.28);
  bodyGroup.add(ledBar);

  // Grip pads de borracha texturizada nas laterais das empunhaduras
  const gripPadGeo = new THREE.CapsuleGeometry(0.24, 0.85, 8, 16);
  const leftGripPad = new THREE.Mesh(gripPadGeo, gripMaterial);
  leftGripPad.position.set(-1.48, -0.02, 0.62);
  leftGripPad.rotation.set(0.35, 0.15, -0.45);
  bodyGroup.add(leftGripPad);

  const rightGripPad = new THREE.Mesh(gripPadGeo, gripMaterial);
  rightGripPad.position.set(1.48, -0.02, 0.62);
  rightGripPad.rotation.set(0.35, -0.15, 0.45);
  bodyGroup.add(rightGripPad);

  // Soquete rebaixado para o Analógico Esquerdo
  const socketGeo = new THREE.TorusGeometry(0.38, 0.045, 16, 32);
  const leftSocket = new THREE.Mesh(socketGeo, centerFaceMaterial);
  leftSocket.rotation.x = Math.PI / 2;
  leftSocket.position.set(-0.80, 0.22, -0.12);
  bodyGroup.add(leftSocket);

  // Soquete rebaixado para o Analógico Direito
  const rightSocket = new THREE.Mesh(socketGeo, centerFaceMaterial);
  rightSocket.rotation.x = Math.PI / 2;
  rightSocket.position.set(0.65, 0.22, 0.35);
  bodyGroup.add(rightSocket);

  root.add(bodyGroup);

  // ==========================================
  // 3. Analógico Esquerdo (Stick_L) - Superior Esquerdo
  // ==========================================
  const stickL = new THREE.Group();
  stickL.name = 'Stick_L';
  stickL.position.set(-0.80, 0.22, -0.12); // Ponto de rotação do gimbal esférico

  const stickSphere = new THREE.SphereGeometry(0.30, 20, 16);
  const stickLBall = new THREE.Mesh(stickSphere, gripMaterial);
  stickLBall.name = 'Stick_L_Ball';
  stickL.add(stickLBall);

  const stickStemGeo = new THREE.CylinderGeometry(0.065, 0.075, 0.25, 16);
  const stickLStem = new THREE.Mesh(stickStemGeo, chromeMaterial);
  stickLStem.name = 'Stick_L_Stem';
  stickLStem.position.y = 0.19;
  stickL.add(stickLStem);

  const stickCapGeo = new THREE.CylinderGeometry(0.34, 0.30, 0.11, 28);
  const stickLCap = new THREE.Mesh(stickCapGeo, stickRubberMaterial);
  stickLCap.name = 'Stick_L_Cap';
  stickLCap.position.y = 0.31;
  stickL.add(stickLCap);

  // Anel texturizado antiderrapante no topo do analógico
  const stickRimGeo = new THREE.TorusGeometry(0.25, 0.032, 12, 24);
  const stickLRim = new THREE.Mesh(stickRimGeo, bodyMaterial);
  stickLRim.rotation.x = Math.PI / 2;
  stickLRim.position.y = 0.36;
  stickL.add(stickLRim);

  root.add(stickL);

  // ==========================================
  // 4. Analógico Direito (Stick_R) - Inferior Direito
  // ==========================================
  const stickR = new THREE.Group();
  stickR.name = 'Stick_R';
  stickR.position.set(0.65, 0.22, 0.35);

  const stickRBall = new THREE.Mesh(stickSphere, gripMaterial);
  stickRBall.name = 'Stick_R_Ball';
  stickR.add(stickRBall);

  const stickRStem = new THREE.Mesh(stickStemGeo, chromeMaterial);
  stickRStem.name = 'Stick_R_Stem';
  stickRStem.position.y = 0.19;
  stickR.add(stickRStem);

  const stickRCap = new THREE.Mesh(stickCapGeo, stickRubberMaterial);
  stickRCap.name = 'Stick_R_Cap';
  stickRCap.position.y = 0.31;
  stickR.add(stickRCap);

  const stickRRim = new THREE.Mesh(stickRimGeo, bodyMaterial);
  stickRRim.rotation.x = Math.PI / 2;
  stickRRim.position.y = 0.36;
  stickR.add(stickRRim);

  root.add(stickR);

  // ==========================================
  // 5. D-Pad Direcional (Cruz) - Inferior Esquerdo
  // ==========================================
  const dpadGroup = new THREE.Group();
  dpadGroup.name = 'Dpad_Group';
  dpadGroup.position.set(-0.65, 0.23, 0.35);

  // Base circular rebaixada
  const dpadBase = new THREE.Mesh(new THREE.CylinderGeometry(0.40, 0.44, 0.08, 32), centerFaceMaterial);
  dpadBase.name = 'Dpad_Base';
  dpadGroup.add(dpadBase);

  // Braços da cruz com entalhes direcionais
  const dpadUp = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.11, 0.28), dpadMaterial);
  dpadUp.name = 'Dpad_Up';
  dpadUp.position.set(0, 0.06, -0.15);
  dpadGroup.add(dpadUp);

  const dpadDown = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.11, 0.28), dpadMaterial);
  dpadDown.name = 'Dpad_Down';
  dpadDown.position.set(0, 0.06, 0.15);
  dpadGroup.add(dpadDown);

  const dpadLeft = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.11, 0.18), dpadMaterial);
  dpadLeft.name = 'Dpad_Left';
  dpadLeft.position.set(-0.15, 0.06, 0);
  dpadGroup.add(dpadLeft);

  const dpadRight = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.11, 0.18), dpadMaterial);
  dpadRight.name = 'Dpad_Right';
  dpadRight.position.set(0.15, 0.06, 0);
  dpadGroup.add(dpadRight);

  const dpadCenter = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.13, 16), dpadMaterial);
  dpadCenter.name = 'Dpad_Center';
  dpadCenter.position.y = 0.06;
  dpadGroup.add(dpadCenter);

  root.add(dpadGroup);

  // ==========================================
  // 6. Botões de Ação ABXY - Superior Direito
  // Padrão clássico em losango:
  //      (Y) [-Z]
  //  (X)     (B)
  //      (A) [+Z]
  // ==========================================
  const createButton = (name, mat, x, y, z) => {
    const btn = new THREE.Group();
    btn.name = name;
    btn.position.set(x, y, z);

    // Base cilíndrica com borda chanfrada
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.09, 24), mat);
    base.position.y = 0.05;
    btn.add(base);

    // Cúpula arredondada brilhante
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.125, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    dome.position.y = 0.085;
    btn.add(dome);

    return btn;
  };

  const btnCenterX = 0.88;
  const btnCenterZ = -0.12;
  const btnDist = 0.23;

  const btnA = createButton('Button_A', btnAMaterial, btnCenterX, 0.22, btnCenterZ + btnDist);
  const btnB = createButton('Button_B', btnBMaterial, btnCenterX + btnDist, 0.22, btnCenterZ);
  const btnX = createButton('Button_X', btnXMaterial, btnCenterX - btnDist, 0.22, btnCenterZ);
  const btnY = createButton('Button_Y', btnYMaterial, btnCenterX, 0.22, btnCenterZ - btnDist);

  root.add(btnA);
  root.add(btnB);
  root.add(btnX);
  root.add(btnY);

  // ==========================================
  // 7. Botões do Sistema (Back, Start, Guide)
  // ==========================================
  const btnBack = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 16), shoulderMaterial);
  btnBack.name = 'Button_Back';
  btnBack.position.set(-0.28, 0.24, -0.04);
  root.add(btnBack);

  const btnStart = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 16), shoulderMaterial);
  btnStart.name = 'Button_Start';
  btnStart.position.set(0.28, 0.24, -0.04);
  root.add(btnStart);

  const btnGuide = new THREE.Group();
  btnGuide.name = 'Button_Guide';
  btnGuide.position.set(0, 0.24, -0.02);
  const guideDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.07, 32), guideGlowMaterial);
  guideDisc.position.y = 0.04;
  btnGuide.add(guideDisc);
  const guideRing = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 12, 32), chromeMaterial);
  guideRing.rotation.x = Math.PI / 2;
  guideRing.position.y = 0.05;
  btnGuide.add(guideRing);
  root.add(btnGuide);

  // ==========================================
  // 8. Bumpers dos Ombros (LB / RB) - Borda Superior (-Z)
  // ==========================================
  const bumperGeo = new THREE.BoxGeometry(0.70, 0.17, 0.30);
  const bumperLB = new THREE.Mesh(bumperGeo, shoulderMaterial);
  bumperLB.name = 'Bumper_LB';
  bumperLB.position.set(-0.85, 0.16, -0.68);
  bumperLB.rotation.set(-0.22, 0.08, 0.10);
  root.add(bumperLB);

  const bumperRB = new THREE.Mesh(bumperGeo, shoulderMaterial);
  bumperRB.name = 'Bumper_RB';
  bumperRB.position.set(0.85, 0.16, -0.68);
  bumperRB.rotation.set(-0.22, -0.08, -0.10);
  root.add(bumperRB);

  // ==========================================
  // 9. Gatilhos Analógicos (Trigger_LT / Trigger_RT)
  // ==========================================
  const createTrigger = (name, x) => {
    const triggerGroup = new THREE.Group();
    triggerGroup.name = name;
    // O ponto de rotação (pivô da dobradiça) fica no topo superior
    triggerGroup.position.set(x, 0.14, -0.88);

    const bladeGeo = new THREE.BoxGeometry(0.42, 0.32, 0.26);
    const blade = new THREE.Mesh(bladeGeo, shoulderMaterial);
    blade.position.set(0, -0.12, -0.06);
    blade.rotation.x = -0.28;
    triggerGroup.add(blade);

    return triggerGroup;
  };

  const triggerLT = createTrigger('Trigger_LT', -0.88);
  const triggerRT = createTrigger('Trigger_RT', 0.88);
  root.add(triggerLT);
  root.add(triggerRT);

  return root;
}
