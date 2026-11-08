/** The logger shape shared with @seydx/rtsp: every method optional. */
export interface Logger {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/** How camera.ui reaches the camera's video. */
export type ConnectionMode = 'rtsp' | 'onvif';

/** Per-camera settings, stored in the camera's own storage. */
export interface AqaraCameraStorage {
  connection: ConnectionMode;
  host: string;
  username: string;
  password: string;
  /** RTSP stream paths the camera serves, best first (e.g. ch1, ch2, ch3). */
  rtspPaths?: string[];
  /** The address rtspPaths were found at; checked again when the address changes. */
  rtspCheckedHost?: string;
  /** ONVIF device service address, e.g. http://192.0.2.50:8000/onvif/device_service. */
  onvifAddress?: string;
  /** Stream URLs ONVIF last returned, highest resolution first, without credentials. */
  onvifStreams?: string[];
  twoWayAudio: boolean;
  /** Aqara device id from mDNS (lumi1.xxxx), used to follow the camera when its IP changes. */
  deviceId?: string;
  model?: string;
}

/** Adoption-form values handed from onAdoptCamera to the camera's first start. */
export type AqaraInitialSettings = Pick<AqaraCameraStorage, 'connection' | 'host' | 'username' | 'password' | 'twoWayAudio'> &
  Partial<Pick<AqaraCameraStorage, 'rtspPaths' | 'rtspCheckedHost' | 'onvifAddress' | 'onvifStreams' | 'deviceId' | 'model'>>;

/** Plugin-level settings: the form for adding a camera by IP. */
export interface AqaraPluginStorage {
  /** Maximum talk call duration in seconds; 0 means no limit. */
  maxCallDuration?: number;
  manualHost?: string;
  manualName?: string;
  /** Talk relays, JSON-encoded (see talk-relay-config.ts). */
  talkRelays?: string;
}
