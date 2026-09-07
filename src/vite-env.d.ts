/// <reference types="vite/client" />

import type { DesktopAPI } from "./types";
import type { ProbeAPI } from './probe/types';

declare global {
  interface Window {
    desktopAPI?: DesktopAPI;
    probeAPI?: ProbeAPI;
  }
}
