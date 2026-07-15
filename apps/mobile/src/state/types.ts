export type DriveStateValue = "active" | "inactive" | "creating" | "seeking" | "failed";
export type DriveOrigin = "hosted" | "received";

export type BackendEvent =
  | { type: "listening" }
  | { type: "connected"; direction: string }
  | { type: "error"; message: string }
  | { type: "debug"; where?: string; msg?: string }
  | {
      type: "upload-progress";
      driveId?: string;
      peerId?: string;
      percent?: number;
      bytesTransferred?: number;
      totalBytes?: number;
      driveSize?: number;
      totalSentBytes?: number;
    }
  | {
      type: "upload-complete";
      driveId?: string;
      peerId?: string;
      totalBytes?: number;
      duration?: number;
      driveSize?: number;
      totalSentBytes?: number;
    }
  | { type: "drive-created"; driveId?: string; shareLink?: string }
  | {
      type: "drive-hydrated";
      driveId?: string;
      shareLink?: string;
      key?: string;
      state?: DriveStateValue;
      origin?: DriveOrigin;
    }
  | {
      type: "drive-activated";
      driveId?: string;
      shareLink?: string;
      key?: string;
    }
  | { type: "drive-deactivated"; driveId?: string }
  | { type: "drive-hydration-failed"; driveId?: string; error?: string }
  | { type: "drive-stopped"; driveId?: string; purged?: boolean }
  | { type: "peer-connected"; driveId?: string; peerId?: string; shareName?: string; totalBytes?: number }
  | { type: "peer-disconnected"; driveId?: string; peerId?: string }
  | { type: "download-peer-disconnected"; driveId?: string };

export type DriveFileEntry = {
  name: string;
  storagePath?: string;
  size?: number;
};

export type DriveLocalFile = {
  name: string;
  path: string;
  size: number;
};

export type DriveRecord = {
  id: string;
  key?: string;
  shareLink?: string;
  name?: string;
  state?: DriveStateValue;
  origin?: DriveOrigin;
  isUpload?: boolean;
  totalBytes?: number;
  files?: DriveFileEntry[];
  /** Local on-disk paths for files the user downloaded — populated when
   *  origin === "received". Lets the UI offer "Open in another app". */
  localFiles?: DriveLocalFile[];
  createdAt?: number;
  lastActivityAt?: number;
};

export type BridgeStatus = {
  stub?: boolean;
  baseDir?: string | null;
  started?: boolean;
  activeCount?: number;
  pendingOpen?: number;
};

export type SharePathsResult = {
  ok: boolean;
  error?: string;
  driveId?: string;
  shareLink?: string;
  key?: string;
};

export type OpenLinkResult = {
  ok: boolean;
  error?: string;
  driveId?: string;
  files?: { name: string; displayName?: string; size?: number }[];
  shareName?: string | null;
  totalBytes?: number;
  hasManifest?: boolean;
  /** D5.1: set when the share's manifest declares more files than the
   *  1000-entry cap allows. UI may surface a "shown N of M" hint. */
  truncated?: { available: number; shown: number };
};

export type DownloadResult = {
  ok: boolean;
  error?: string;
  files?: { name: string; path: string; size: number }[];
  failed?: { key: string; error: string }[];
  totalBytes?: number;
  duration?: number;
  destDir?: string;
};

export type TransferDirection = "upload" | "download" | "unknown";
export type TransferOrigin = "hosted" | "received" | "unknown";

export type TransferSummary = {
  driveId: string;
  /**
   * Who created/owns the drive on this device.
   * "hosted" → we created the drive locally via sharePaths; peers connecting to us are downloading.
   * "received" → we discovered the drive via a share link and are the consumer.
   * This is the authoritative grouping signal for Share-tab vs Receive-tab UI.
   */
  origin: TransferOrigin;
  /**
   * Derived direction for legacy UI; prefer `origin`. Kept for compatibility.
   */
  direction: TransferDirection;
  percent: number | null;
  bytesTransferred: number;
  totalBytes: number | null;
  driveSize: number | null;
  totalSentBytes: number;
  peersConnected: number;
  peerIds: string[];
  /** True only on explicit upload-complete (never implied by percent ≥ 100). */
  completed: boolean;
  /**
   * true once at least one upload-progress event has been
   * processed for this transfer. Lets the UI distinguish "connected but
   * no flow yet" from "data is moving" without trusting the engine's
   * unreliable `socket.bytesWritten`-based percent. Also gates the stall
   * detector so it doesn't fire on legitimately-slow start-of-transfer.
   */
  progressEverReceived: boolean;
  /**
   * .3: true when a received transfer that was previously
   * progressing has had no events for >30 s. Triggers the "Couldn't
   * finish the download — the other side may have disconnected." toast
   * in ReceiveScreen exactly once, then stays true so the toast doesn't
   * re-fire if the user lingers on the same stuck card. Hosted transfers
   * don't use this flag — they're flipped straight to `completed: true`
   * by the same stall detector.
   */
  stalled: boolean;
  lastEventAt: number;
};
