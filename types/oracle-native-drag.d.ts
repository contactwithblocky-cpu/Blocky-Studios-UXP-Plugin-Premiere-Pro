declare module "oracle-native-drag.uxpaddon" {
  export interface NativeDragResult {
    requestId: number;
    ok: boolean;
    dropped: boolean;
    cancelled: boolean;
    effect: number;
    hresult: number;
    errorCode: string;
    errorMessage: string;
    nativeDispatchMs: number;
    lastStage:
      | "REQUEST_RECEIVED"
      | "PATH_VALIDATED"
      | "LEFT_BUTTON_CONFIRMED"
      | "WORKER_DISPATCHED"
      | "DO_DRAG_DROP_ENTERED"
      | "DO_DRAG_DROP_RETURNED";
    requestReceived: boolean;
    pathValidated: boolean;
    leftButtonConfirmed: boolean;
    workerDispatched: boolean;
    doDragDropEntered: boolean;
    doDragDropReturned: boolean;
  }

  export interface NativeDragSnapshot {
    requestId: number;
    stage: string;
    requestReceived: boolean;
    pathValidated: boolean;
    leftButtonConfirmed: boolean;
    workerQueued: boolean;
    workerAwakened: boolean;
    oleInitialized: boolean;
    doDragDropEntered: boolean;
    doDragDropReturned: boolean;
    queryContinueDragCalls: number;
    giveFeedbackCalls: number;
    lastKeyState: number;
    escapeObserved: boolean;
    currentEffect: number;
    finalEffect: number;
    hresult: number;
    oleInitializeHresult: number;
    workerThreadId: number;
    callerThreadId: number;
    foregroundWindow: number;
    foregroundProcessId: number;
    foregroundWindowThreadId: number;
    cursorX: number;
    cursorY: number;
    promiseCreated: boolean;
    promiseResolved: boolean;
    promiseRejected: boolean;
    elapsedMs: number;
  }

  export interface NativeSelfTestResult {
    ok: boolean;
    addonVersion: string;
    architecture: "x64";
    platform: "win32";
    workerAvailable: boolean;
    oleWorkerState: string;
  }

  export function startNativeFileDrag(absolutePath: string): Promise<NativeDragResult>;
  export function nativeSelfTest(): NativeSelfTestResult;
  export function getNativeDragSnapshot(): NativeDragSnapshot;
}
