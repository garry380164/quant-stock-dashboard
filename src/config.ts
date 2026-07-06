/**
 * 集中管理與後端 API / WebSocket 的連線網址。
 * 優先讀取環境變數，若無則 fallback 回本地開發用的 localhost。
 */

// 後端 HTTP API 的基礎路徑 (例如: http://localhost:8080 或 https://quant-stock-backend.fly.dev)
export const NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

// 後端 WebSocket 的連線路徑 (例如: ws://localhost:8080 或 wss://quant-stock-backend.fly.dev)
export const NEXT_PUBLIC_WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080';
