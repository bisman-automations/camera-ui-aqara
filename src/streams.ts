import type { CameraConfig, StreamingRole } from '@camera.ui/sdk';

/** camera.ui has three streaming roles; streams are handed out to them best first. */
const ROLES_BY_COUNT: Record<number, StreamingRole[]> = {
  1: ['high-resolution'],
  2: ['high-resolution', 'low-resolution'],
  3: ['high-resolution', 'mid-resolution', 'low-resolution'],
};

const SOURCE_NAMES: Record<StreamingRole, string> = {
  'high-resolution': 'High',
  'mid-resolution': 'Medium',
  'low-resolution': 'Low',
};

/** The streaming role each of `count` streams (best first) gets. More than three are cut. */
export function rolesFor(count: number): StreamingRole[] {
  return ROLES_BY_COUNT[Math.min(Math.max(count, 0), 3)] ?? [];
}

/** Which of the camera's streams (index, best first) serves a role, or undefined. */
export function streamIndexForRole(role: string | undefined, count: number): number | undefined {
  if (!role) return undefined;
  const index = rolesFor(count).indexOf(role as StreamingRole);
  return index < 0 ? undefined : index;
}

export interface CameraConfigInput {
  name: string;
  nativeId: string;
  /** Number of streams the camera serves (1 to 3), best first. */
  streamCount: number;
  doorbell: boolean;
  info: CameraConfig['info'];
}

/**
 * The configuration camera.ui stores for a newly adopted camera.
 *
 * Every source is served by the plugin (no URLs here): camera.ui asks the
 * plugin's `streamUrl()` for the address each time, so a new IP, a changed
 * password or a switch between RTSP and ONVIF never leaves a stale URL behind,
 * and the high-resolution source can go through the relay that carries
 * two-way audio.
 */
export function buildCameraConfig(input: CameraConfigInput): CameraConfig {
  const roles = rolesFor(input.streamCount);
  return {
    name: input.name,
    nativeId: input.nativeId,
    type: input.doorbell ? 'doorbell' : 'camera',
    info: input.info,
    sources: roles.map((role, index) => ({
      name: SOURCE_NAMES[role],
      role,
      // Snapshots come from the smallest stream, so they do not compete with live view.
      useForSnapshot: index === roles.length - 1,
      hotMode: index === 0,
      preload: index === 0,
      timeout: 30,
    })),
  };
}
