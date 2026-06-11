import { WebSocket } from 'ws';

export let activeWs: WebSocket | null = null;

export function setActiveWs(ws: WebSocket | null) {
  activeWs = ws;
}
