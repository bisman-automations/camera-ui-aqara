export interface AqaraModel {
  /** Model code the camera advertises over mDNS, e.g. lumi.camera.agl005. */
  code: string;
  name: string;
  doorbell: boolean;
}

/**
 * Aqara camera models by the model code in their mDNS TXT record. Taken from
 * https://github.com/absent42/Aqara-Camera-2-Way-Audio and
 * https://github.com/resonaura/aqara-g5pro-mqtt (both MIT). Two-way audio is
 * confirmed on the G100, G400 and G410; the others share the same firmware
 * family and are expected to work.
 */
const MODELS: AqaraModel[] = [
  { code: 'lumi.camera.acn001', name: 'Camera Hub G3', doorbell: false },
  { code: 'lumi.camera.acn003', name: 'Camera Hub G2H Pro', doorbell: false },
  { code: 'lumi.camera.acn004', name: 'Camera Hub G2H Pro', doorbell: false },
  { code: 'lumi.camera.acn005', name: 'G4 Doorbell', doorbell: true },
  { code: 'lumi.camera.acn006', name: 'Camera E1', doorbell: false },
  { code: 'lumi.camera.acn007', name: 'Camera E1', doorbell: false },
  { code: 'lumi.camera.acn010', name: 'Camera Hub G5 Pro (PoE)', doorbell: false },
  { code: 'lumi.camera.acn017', name: 'G410 Doorbell Camera Hub', doorbell: true },
  { code: 'lumi.camera.agl001', name: 'Camera Hub G2H Pro', doorbell: false },
  { code: 'lumi.camera.agl002', name: 'G4 Doorbell', doorbell: true },
  { code: 'lumi.camera.agl003', name: 'Camera Hub G5 Pro (Wi-Fi)', doorbell: false },
  { code: 'lumi.camera.agl004', name: 'Camera Hub G5 Pro (Wi-Fi)', doorbell: false },
  { code: 'lumi.camera.agl005', name: 'Camera G100', doorbell: false },
  { code: 'lumi.camera.agl006', name: 'G410 Doorbell Camera Hub', doorbell: true },
  { code: 'lumi.camera.agl013', name: 'G400 Video Doorbell', doorbell: true },
  { code: 'lumi.camera.gwac02', name: 'Camera Hub G2H', doorbell: false },
  { code: 'lumi.camera.gwac03', name: 'Camera Hub G2H', doorbell: false },
  { code: 'lumi.camera.gwag03', name: 'Camera Hub G2H', doorbell: false },
  { code: 'lumi.camera.gwpagl01', name: 'Camera Hub G3', doorbell: false },
  { code: 'lumi.camera.gwpgl1', name: 'Camera Hub G3', doorbell: false },
];

const BY_CODE = new Map(MODELS.map((model) => [model.code, model]));

export function lookupModel(code: string | undefined): AqaraModel | undefined {
  return code ? BY_CODE.get(code.toLowerCase()) : undefined;
}

/** The friendly name for a model code, or a name built from what is known. */
export function modelName(code: string | undefined, fallback?: string): string | undefined {
  return lookupModel(code)?.name ?? fallback ?? code;
}

/** Whether the camera is a doorbell, judged by model code or, failing that, by its name. */
export function isDoorbell(code: string | undefined, name?: string): boolean {
  const model = lookupModel(code);
  if (model) return model.doorbell;
  return /doorbell/i.test(name ?? '');
}
