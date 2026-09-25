/**
 * SeeMyGame - Gamepad 3D Model Builder (Procedural & GLTF Geometry)
 * Constrói a geometria tridimensional do controle com materiais PBR e peças articuladas.
 */

import * as THREE from 'three';

export function createGamepadModel() {
  const root = new THREE.Group();
  root.name = 'GamepadRoot';

  // 1. Materiais PBR Gamer de Alta Fidelidade
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x181a24,
    roughness: 0.52,
    metalness: 0.18,
    name: 'Mat_GamepadBody'
  });

  const gripMaterial = new THREE.MeshStandardMaterial({
    color: 0x12141d,
    roughness: 0.75,
    metalness: 0.1,
    name: 'Mat_Grip'
  });

  const centerPlateMaterial = new THREE.MeshStandardMaterial({
    color: 0x222636,
    roughness: 0.45,
    metalness: 0.25,
    name: 'Mat_CenterPlate'
  });

  const chromeMaterial = new THREE.MeshStandardMaterial({
    color: 0x9ba3b4,
    metalness: 0.9,
    roughness: 0.15,
    name: 'Mat_Chrome'
  });

  const stickRubberMaterial = new THREE.MeshStandardMaterial({
    color: 0x262938,
    roughness: 0.85,
    metalness: 0.05,
    name: 'Mat_StickRubber'
  });

  const dpadMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b2e40,
    metalness: 0.6,
    roughness: 0.35,
    name: 'Mat_Dpad'
  });

  const shoulderMaterial = new THREE.MeshStandardMaterial({
    color: 0x202330,
    roughness: 0.4,
    metalness: 0.3,
    name: 'Mat_Shoulder'
  });

  // Materiais coloridos para botões de ação (ABXY)
  const btnAMaterial = new THREE.MeshStandardMaterial({
    color: 0x10b981,
    emissive: 0x054631,
    roughness: 0.25,
    metalness: 0.2,
    name: 'Mat_ButtonA'
  });

  const btnBMaterial = new THREE.MeshStandardMaterial({
    color: 0xef4444,
    emissive: 0x5a1818,
    roughness: 0.25,
    metalness: 0.2,
    name: 'Mat_ButtonB'
  });

  const btnXMaterial = new THREE.MeshStandardMaterial({
    color: 0x3b82f6,
    emissive: 0x13386e,
    roughness: 0.25,
    metalness: 0.2,
    name: 'Mat_ButtonX'
  });

  const btnYMaterial = new THREE.MeshStandardMaterial({
    color: 0xf59e0b,
    emissive: 0x563806,
    roughness: 0.25,
    metalness: 0.2,
    name: 'Mat_ButtonY'
  });

  const guideGlowMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x8b5cf6,
    emissiveIntensity: 0.6,
    roughness: 0.1,
    metalness: 0.3,
    name: 'Mat_GuideGlow'
  });

  // 2. Chassi do Controle (Body)
  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'Body';

  // Bloco central ergonômico
  const mainBodyGeo = new THREE.CylinderGeometry(1.6, 1.8, 0.6, 32);
  mainBodyGeo.scale(1.3, 0.9, 0.85);
  const mainBodyMesh = new THREE.Mesh(mainBodyGeo, bodyMaterial);
  mainBodyMesh.rotation.x = Math.PI / 2;
  bodyGroup.add(mainBodyMesh);

  // Painel central esculpido
  const centerPlateGeo = new THREE.CylinderGeometry(1.15, 1.25, 0.65, 32);
  centerPlateGeo.scale(1.1, 0.95, 0.7);
  const centerPlateMesh = new THREE.Mesh(centerPlateGeo, centerPlateMaterial);
  centerPlateMesh.rotation.x = Math.PI / 2;
  centerPlateMesh.position.set(0, 0.05, 0.05);
  bodyGroup.add(centerPlateMesh);

  // Manopla esquerda (Grip L)
  const leftGripGeo = new THREE.CylinderGeometry(0.55, 0.75, 2.2, 24);
  const leftGripMesh = new THREE.Mesh(leftGripGeo, gripMaterial);
  leftGripMesh.position.set(-1.65, -0.05, -0.65);
  leftGripMesh.rotation.set(-0.25, 0.1, 0.42);
  bodyGroup.add(leftGripMesh);

  // Manopla direita (Grip R)
  const rightGripGeo = new THREE.CylinderGeometry(0.55, 0.75, 2.2, 24);
  const rightGripMesh = new THREE.Mesh(rightGripGeo, gripMaterial);
  rightGripMesh.position.set(1.65, -0.05, -0.65);
  rightGripMesh.rotation.set(-0.25, -0.1, -0.42);
  bodyGroup.add(rightGripMesh);

  // Recessos dos analógicos (Soquetes côncavos)
  const socketGeo = new THREE.TorusGeometry(0.48, 0.07, 16, 32);
  const leftSocket = new THREE.Mesh(socketGeo, bodyMaterial);
  leftSocket.rotation.x = Math.PI / 2;
  leftSocket.position.set(-0.95, 0.32, 0.35);
  bodyGroup.add(leftSocket);

  const rightSocket = new THREE.Mesh(socketGeo, bodyMaterial);
  rightSocket.rotation.x = Math.PI / 2;
  rightSocket.position.set(0.65, 0.32, -0.28);
  bodyGroup.add(rightSocket);

  root.add(bodyGroup);

  // 3. Analógico Esquerdo (Stick_L) - Articulação esférica com pivô exato
  const stickL = new THREE.Group();
  stickL.name = 'Stick_L';
  stickL.position.set(-0.95, 0.28, 0.35); // Posição de montagem do pivô

  const stickLBall = new THREE.Mesh(new THREE.SphereGeometry(0.38, 20, 16), gripMaterial);
  stickLBall.name = 'Stick_L_Ball';
  stickL.add(stickLBall);

  const stickLStem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.32, 16), chromeMaterial);
  stickLStem.name = 'Stick_L_Stem';
  stickLStem.position.y = 0.24;
  stickL.add(stickLStem);

  const stickLCap = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.38, 0.14, 28), stickRubberMaterial);
  stickLCap.name = 'Stick_L_Cap';
  stickLCap.position.y = 0.40;
  stickL.add(stickLCap);

  const stickLRing = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.04, 12, 24), bodyMaterial);
  stickLRing.rotation.x = Math.PI / 2;
  stickLRing.position.y = 0.46;
  stickL.add(stickLRing);
  root.add(stickL);

  // 4. Analógico Direito (Stick_R)
  const stickR = new THREE.Group();
  stickR.name = 'Stick_R';
  stickR.position.set(0.65, 0.28, -0.28);

  const stickRBall = new THREE.Mesh(new THREE.SphereGeometry(0.38, 20, 16), gripMaterial);
  stickRBall.name = 'Stick_R_Ball';
  stickR.add(stickRBall);

  const stickRStem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.32, 16), chromeMaterial);
  stickRStem.name = 'Stick_R_Stem';
  stickRStem.position.y = 0.24;
  stickR.add(stickRStem);

  const stickRCap = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.38, 0.14, 28), stickRubberMaterial);
  stickRCap.name = 'Stick_R_Cap';
  stickRCap.position.y = 0.40;
  stickR.add(stickRCap);

  const stickRRing = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.04, 12, 24), bodyMaterial);
  stickRRing.rotation.x = Math.PI / 2;
  stickRRing.position.y = 0.46;
  stickR.add(stickRRing);
  root.add(stickR);

  // 5. D-Pad (Direcional Digital)
  const dpadGroup = new THREE.Group();
  dpadGroup.name = 'Dpad_Group';
  dpadGroup.position.set(-0.65, 0.32, -0.28);

  const dpadBase = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.52, 0.12, 32), bodyMaterial);
  dpadBase.name = 'Dpad_Base';
  dpadGroup.add(dpadBase);

  // Braços do D-pad com nomes para clique individual
  const dpadUp = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.34), dpadMaterial);
  dpadUp.name = 'Dpad_Up';
  dpadUp.position.set(0, 0.07, 0.20);
  dpadGroup.add(dpadUp);

  const dpadDown = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.34), dpadMaterial);
  dpadDown.name = 'Dpad_Down';
  dpadDown.position.set(0, 0.07, -0.20);
  dpadGroup.add(dpadDown);

  const dpadLeft = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.24), dpadMaterial);
  dpadLeft.name = 'Dpad_Left';
  dpadLeft.position.set(-0.20, 0.07, 0);
  dpadGroup.add(dpadLeft);

  const dpadRight = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.24), dpadMaterial);
  dpadRight.name = 'Dpad_Right';
  dpadRight.position.set(0.20, 0.07, 0);
  dpadGroup.add(dpadRight);

  const dpadCenter = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.15, 16), dpadMaterial);
  dpadCenter.name = 'Dpad_Center';
  dpadCenter.position.y = 0.07;
  dpadGroup.add(dpadCenter);

  root.add(dpadGroup);

  // 6. Botões de Ação (ABXY) - Losango Clássico
  const createButton = (name, mat, x, y, z) => {
    const btn = new THREE.Group();
    btn.name = name;
    btn.position.set(x, y, z);

    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.12, 24), mat);
    base.position.y = 0.06;
    btn.add(base);

    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    dome.position.y = 0.11;
    btn.add(dome);

    return btn;
  };

  const btnA = createButton('Button_A', btnAMaterial, 1.25, 0.32, 0.12);
  const btnB = createButton('Button_B', btnBMaterial, 1.55, 0.32, 0.35);
  const btnX = createButton('Button_X', btnXMaterial, 0.95, 0.32, 0.35);
  const btnY = createButton('Button_Y', btnYMaterial, 1.25, 0.32, 0.58);

  root.add(btnA);
  root.add(btnB);
  root.add(btnX);
  root.add(btnY);

  // 7. Botões do Sistema (Back, Start, Guide)
  const btnBack = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.11), shoulderMaterial);
  btnBack.name = 'Button_Back';
  btnBack.position.set(-0.35, 0.36, 0.28);
  root.add(btnBack);

  const btnStart = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.11), shoulderMaterial);
  btnStart.name = 'Button_Start';
  btnStart.position.set(0.35, 0.36, 0.28);
  root.add(btnStart);

  const btnGuide = new THREE.Group();
  btnGuide.name = 'Button_Guide';
  btnGuide.position.set(0, 0.36, 0.55);
  const guideDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.10, 32), guideGlowMaterial);
  guideDisc.position.y = 0.05;
  btnGuide.add(guideDisc);
  const guideRing = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.03, 12, 32), chromeMaterial);
  guideRing.rotation.x = Math.PI / 2;
  guideRing.position.y = 0.06;
  btnGuide.add(guideRing);
  root.add(btnGuide);

  // 8. Bumpers dos Ombros (LB / RB)
  const bumperLB = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.38), shoulderMaterial);
  bumperLB.name = 'Bumper_LB';
  bumperLB.position.set(-1.05, 0.38, 1.15);
  bumperLB.rotation.set(-0.3, 0.05, 0.12);
  root.add(bumperLB);

  const bumperRB = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.38), shoulderMaterial);
  bumperRB.name = 'Bumper_RB';
  bumperRB.position.set(1.05, 0.38, 1.15);
  bumperRB.rotation.set(-0.3, -0.05, -0.12);
  root.add(bumperRB);

  // 9. Gatilhos Analógicos (Trigger_LT / Trigger_RT) - Articulação em dobradiça superior
  const triggerLT = new THREE.Group();
  triggerLT.name = 'Trigger_LT';
  triggerLT.position.set(-1.10, 0.36, 1.38); // Eixo da dobradiça
  const triggerLTMesh = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.42, 0.36), shoulderMaterial);
  triggerLTMesh.position.set(0, -0.16, 0.12);
  triggerLTMesh.rotation.x = -0.35;
  triggerLT.add(triggerLTMesh);
  root.add(triggerLT);

  const triggerRT = new THREE.Group();
  triggerRT.name = 'Trigger_RT';
  triggerRT.position.set(1.10, 0.36, 1.38);
  const triggerRTMesh = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.42, 0.36), shoulderMaterial);
  triggerRTMesh.position.set(0, -0.16, 0.12);
  triggerRTMesh.rotation.x = -0.35;
  triggerRT.add(triggerRTMesh);
  root.add(triggerRT);

  return root;
}
