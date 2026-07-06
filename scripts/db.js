const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 資料庫檔案路徑
const DB_PATH = path.join(__dirname, '..', 'quant.db');
const db = new sqlite3.Database(DB_PATH);
const MAX_KLINE_VOLUME = 2000000000;
const ADJACENT_OPEN_GAP_TRIGGER = 0.005;
const ADJACENT_OPEN_GAP_MIN = 0.003;
const ADJACENT_OPEN_GAP_MAX = 0.01;

// 隨機數輔助函數
const randomInRange = (min, max) => Math.random() * (max - min) + min;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function smoothAdjacentOpenGap(previousClose, bar) {
  const safePreviousClose = Math.max(Number(previousClose) || 0, 0.01);
  const safeOpen = Math.max(Number(bar.open) || safePreviousClose, 0.01);
  const gapPct = (safeOpen - safePreviousClose) / safePreviousClose;
  const absGapPct = Math.abs(gapPct);
  if (absGapPct <= ADJACENT_OPEN_GAP_TRIGGER) return bar;

  const targetGapPct = clamp(absGapPct, ADJACENT_OPEN_GAP_MIN, ADJACENT_OPEN_GAP_MAX);
  const targetOpen = safePreviousClose * (1 + (gapPct >= 0 ? targetGapPct : -targetGapPct));
  let roundedOpen = parseFloat(Math.max(targetOpen, 0.01).toFixed(2));
  if (gapPct >= 0) {
    while (roundedOpen > 0 && ((roundedOpen - safePreviousClose) / safePreviousClose) > ADJACENT_OPEN_GAP_MAX) {
      roundedOpen = parseFloat((roundedOpen - 0.01).toFixed(2));
    }
    while (((roundedOpen - safePreviousClose) / safePreviousClose) < ADJACENT_OPEN_GAP_MIN) {
      roundedOpen = parseFloat((roundedOpen + 0.01).toFixed(2));
    }
  } else {
    while (roundedOpen > 0 && ((safePreviousClose - roundedOpen) / safePreviousClose) > ADJACENT_OPEN_GAP_MAX) {
      roundedOpen = parseFloat((roundedOpen + 0.01).toFixed(2));
    }
    while (((safePreviousClose - roundedOpen) / safePreviousClose) < ADJACENT_OPEN_GAP_MIN) {
      roundedOpen = parseFloat((roundedOpen - 0.01).toFixed(2));
    }
  }
  const nextBar = { ...bar, open: roundedOpen };
  nextBar.high = parseFloat(Math.max(nextBar.high, nextBar.open, nextBar.close, 0.01).toFixed(2));
  nextBar.low = parseFloat(Math.max(Math.min(nextBar.low, nextBar.open, nextBar.close), 0.01).toFixed(2));
  nextBar.high = Math.max(nextBar.high, nextBar.open, nextBar.close);
  nextBar.low = Math.min(nextBar.low, nextBar.open, nextBar.close);
  return nextBar;
}

// 預設個股資料
const initialStocksUS = [
  { symbol: 'AAPL', name: 'Apple Inc.', price: 182.52, change: 1.25, changePercent: 0.69, high24h: 184.20, low24h: 181.12, volume: 54.2, isFav: true },
  { symbol: 'MSFT', name: 'Microsoft Corp.', price: 415.50, change: -2.45, changePercent: -0.59, high24h: 420.12, low24h: 413.20, volume: 22.8, isFav: true },
  { symbol: 'TSLA', name: 'Tesla Inc.', price: 175.34, change: 8.42, changePercent: 5.04, high24h: 178.50, low24h: 166.30, volume: 88.5, isFav: true },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', price: 875.12, change: 24.15, changePercent: 2.84, high24h: 884.80, low24h: 850.10, volume: 48.9, isFav: true },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', price: 151.60, change: -0.85, changePercent: -0.56, high24h: 153.20, low24h: 150.50, volume: 28.3, isFav: false },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', price: 178.15, change: 1.98, changePercent: 1.12, high24h: 179.43, low24h: 176.02, volume: 31.4, isFav: false },
];

const initialStocksTW = [
  { symbol: '2330.TW', name: '台積電 (TSMC)', price: 790.00, change: 12.00, changePercent: 1.54, high24h: 796.00, low24h: 782.00, volume: 32.4, isFav: true },
  { symbol: '2317.TW', name: '鴻海 (Foxconn)', price: 155.50, change: -1.50, changePercent: -0.96, high24h: 158.00, low24h: 154.00, volume: 45.2, isFav: true },
  { symbol: '2454.TW', name: '聯發科 (MediaTek)', price: 1120.00, change: 25.00, changePercent: 2.28, high24h: 1135.00, low24h: 1095.00, volume: 4.8, isFav: true },
  { symbol: '2308.TW', name: '台 delta 電 (Delta)', price: 342.00, change: 5.50, changePercent: 1.63, high24h: 345.00, low24h: 338.00, volume: 8.9, isFav: false },
  { symbol: '2881.TW', name: '富邦金 (Fubon)', price: 71.20, change: -0.30, changePercent: -0.42, high24h: 71.90, low24h: 70.80, volume: 15.6, isFav: false },
  { symbol: '2603.TW', name: '長榮 (Evergreen)', price: 172.50, change: -4.50, changePercent: -2.54, high24h: 178.00, low24h: 171.00, volume: 22.1, isFav: false },
];

// 生成歷史 K 線數據的後端實作
function generateHistoryKLines(symbol, basePrice, count = 200, timeframe = '1h') {
  const data = [];
  let currentPrice = basePrice;
  let timestamp = Date.now() - count * 60 * 60 * 1000;

  if (timeframe === '15m') {
    timestamp = Date.now() - count * 15 * 60 * 1000;
  } else if (timeframe === '1d') {
    timestamp = Date.now() - count * 24 * 60 * 60 * 1000;
  }

  const interval = timeframe === '15m' ? 15 * 60 * 1000 : timeframe === '1d' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const changePercent = randomInRange(-0.02, 0.021);
    const open = currentPrice;
    const close = currentPrice * (1 + changePercent);
    const high = Math.max(open, close) * randomInRange(1, 1.015);
    const low = Math.min(open, close) * randomInRange(0.985, 1);
    const volume = Math.round(randomInRange(50000, 500000));
    const bar = {
      timestamp,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume,
    };

    if (data.length > 0) {
      const previousClose = data[data.length - 1].close;
      const adjustedBar = smoothAdjacentOpenGap(previousClose, bar);
      bar.open = adjustedBar.open;
      bar.high = adjustedBar.high;
      bar.low = adjustedBar.low;
      bar.close = adjustedBar.close;
    }

    data.push(bar);

    currentPrice = bar.close;
    timestamp += interval;
  }
  return data;
}

// 初始化資料庫
function initDb() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // 1. 建立 stocks 表格
      db.run(`
        CREATE TABLE IF NOT EXISTS stocks (
          symbol TEXT PRIMARY KEY,
          name TEXT,
          price REAL,
          change REAL,
          changePercent REAL,
          high24h REAL,
          low24h REAL,
          volume REAL,
          market TEXT,
          isFav INTEGER DEFAULT 0
        )
      `);

      // 2. 建立 klines 表格
      db.run(`
        CREATE TABLE IF NOT EXISTS klines (
          symbol TEXT,
          timeframe TEXT,
          timestamp INTEGER,
          open REAL,
          high REAL,
          low REAL,
          close REAL,
          volume INTEGER,
          PRIMARY KEY (symbol, timeframe, timestamp)
        )
      `);

      // 3. 填入初始個股資料
      db.get('SELECT COUNT(*) as count FROM stocks', (err, row) => {
        if (err) return reject(err);
        if (row.count === 0) {
          console.log('📦 Initializing stocks database...');
          const stmt = db.prepare('INSERT INTO stocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
          
          initialStocksUS.forEach(s => {
            stmt.run(s.symbol, s.name, s.price, s.change, s.changePercent, s.high24h, s.low24h, s.volume, 'US', s.isFav ? 1 : 0);
          });

          initialStocksTW.forEach(s => {
            stmt.run(s.symbol, s.name, s.price, s.change, s.changePercent, s.high24h, s.low24h, s.volume, 'TW', s.isFav ? 1 : 0);
          });

          stmt.finalize((stmtErr) => {
            if (stmtErr) return reject(stmtErr);
            // 4. 填入 K 線資料
            initializeAllKLines().then(resolve).catch(reject);
          });
        } else {
          resolve();
        }
      });
    });
  });
}

// 為所有股票的所有週期產生並寫入 K 線
function initializeAllKLines() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM klines', (err, row) => {
      if (err) return reject(err);
      if (row.count > 0) return resolve();

      console.log('📊 Initializing KLine history database (this might take a second)...');
      
      // 讀取所有剛寫入的股票
      db.all('SELECT symbol, price FROM stocks', (allErr, stocks) => {
        if (allErr) return reject(allErr);

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          const stmt = db.prepare('INSERT OR IGNORE INTO klines VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
          
          stocks.forEach(stock => {
            ['15m', '1h', '1d'].forEach(tf => {
              const klines = generateHistoryKLines(stock.symbol, stock.price, 1000, tf);
              klines.forEach(k => {
                stmt.run(stock.symbol, tf, k.timestamp, k.open, k.high, k.low, k.close, k.volume);
              });
            });
          });

          stmt.finalize((stmtErr) => {
            if (stmtErr) {
              db.run('ROLLBACK');
              return reject(stmtErr);
            }
            db.run('COMMIT', (commitErr) => {
              if (commitErr) return reject(commitErr);
              console.log('✅ KLines database initialized successfully!');
              resolve();
            });
          });
        });
      });
    });
  });
}

// 獲取股票清單
function getStocks(market) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM stocks WHERE market = ?', [market], (err, rows) => {
      if (err) return reject(err);
      // 把 isFav 轉換成 boolean
      const stocks = rows.map(r => ({
        ...r,
        isFav: r.isFav === 1
      }));
      resolve(stocks);
    });
  });
}

// 獲取特定 K 線
function getKLines(symbol, timeframe, limit = null, before = null) {
  return new Promise((resolve, reject) => {
    const sourceTimeframe = timeframe === '15m' ? timeframe : '15m';
    const params = [symbol, sourceTimeframe];
    let beforeClause = '';
    if (before && timeframe === '15m') {
      beforeClause = ' AND timestamp < ?';
      params.push(Number(before));
    }

    let query = `SELECT timestamp, open, high, low, close, volume FROM klines WHERE symbol = ? AND timeframe = ?${beforeClause} ORDER BY timestamp ASC`;
    if (limit && timeframe === '15m') {
      params.push(Number(limit));
      query = `
        SELECT timestamp, open, high, low, close, volume
        FROM (
          SELECT timestamp, open, high, low, close, volume
          FROM klines
          WHERE symbol = ? AND timeframe = ?${beforeClause}
          ORDER BY timestamp DESC
          LIMIT ?
        )
        ORDER BY timestamp ASC
      `;
    }

    db.all(
      query,
      params,
      (err, rows) => {
        if (err) return reject(err);
        if (timeframe === '15m') {
          resolve(rows);
          return;
        }

        let aggregated = aggregateKLinesFrom15m(symbol, rows, timeframe);
        if (before) {
          aggregated = aggregated.filter((bar) => Number(bar.timestamp) < Number(before));
        }
        if (limit) {
          aggregated = aggregated.slice(-Number(limit));
        }
        resolve(aggregated);
      }
    );
  });
}

function getAggregateBucketTimestamp(timestamp, timeframe) {
  const date = new Date(Number(timestamp));
  if (timeframe === '1h') {
    date.setUTCMinutes(0, 0, 0);
    return date.getTime();
  }
  if (timeframe === '4h') {
    date.setUTCHours(Math.floor(date.getUTCHours() / 4) * 4, 0, 0, 0);
    return date.getTime();
  }
  if (timeframe === '1d') {
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }
  if (timeframe === '1w') {
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - day + 1);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }
  if (timeframe === '1M') {
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }
  return Number(timestamp);
}

function aggregateKLinesFrom15m(symbol, rows, timeframe) {
  const buckets = new Map();
  rows
    .slice()
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
    .forEach((row) => {
      const bucketTs = getAggregateBucketTimestamp(row.timestamp, timeframe);
      const current = buckets.get(bucketTs);
      if (!current) {
        buckets.set(bucketTs, {
          timestamp: bucketTs,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume) || 0,
        });
        return;
      }

      current.high = Math.max(current.high, Number(row.high));
      current.low = Math.min(current.low, Number(row.low));
      current.close = Number(row.close);
      current.volume = Math.min(MAX_KLINE_VOLUME, current.volume + (Number(row.volume) || 0));
    });

  return Array.from(buckets.values());
}

// 變更自選股狀態
function toggleFav(symbol) {
  return new Promise((resolve, reject) => {
    db.get('SELECT isFav FROM stocks WHERE symbol = ?', [symbol], (err, row) => {
      if (err) return reject(err);
      if (!row) return reject(new Error('Stock not found'));
      const nextFav = row.isFav === 1 ? 0 : 1;
      
      db.run('UPDATE stocks SET isFav = ? WHERE symbol = ?', [nextFav, symbol], (upErr) => {
        if (upErr) return reject(upErr);
        resolve(nextFav === 1);
      });
    });
  });
}

// 背景定時更新：在一個 Transaction 中批次更新所有股票價格及對應的各個 timeframe K 線最後一個 Bar
function updateAllPricesAndKLines(stocksList, marketType) {
  return new Promise((resolve, reject) => {
    const nowTs = Date.now();
    
    // 我們需要先獲取所有 klines 中每一組的最後一根 Bar timestamp，用來判斷是否需要新 Bar
    db.all('SELECT symbol, timeframe, MAX(timestamp) as lastTs, open, high, low, close, volume FROM klines GROUP BY symbol, timeframe', (err, lastBars) => {
      if (err) return reject(err);
      
      // 整理成 Map 結構方便尋找
      const barMap = new Map(); // key: symbol_timeframe -> barData
      lastBars.forEach(b => {
        barMap.set(`${b.symbol}_${b.timeframe}`, b);
      });

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        const updateStockStmt = db.prepare(`
          UPDATE stocks 
          SET price = ?, change = ?, changePercent = ?, high24h = ?, low24h = ?
          WHERE symbol = ?
        `);

        const insertKLineStmt = db.prepare(`
          INSERT INTO klines (symbol, timeframe, timestamp, open, high, low, close, volume)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const updateKLineStmt = db.prepare(`
          UPDATE klines
          SET open = ?, high = ?, low = ?, close = ?, volume = ?
          WHERE symbol = ? AND timeframe = ? AND timestamp = ?
        `);

        stocksList.forEach(stock => {
          // 1. 更新股票
          updateStockStmt.run(
            stock.price,
            stock.change,
            stock.changePercent,
            stock.high24h,
            stock.low24h,
            stock.symbol
          );

          // 2. Keep 15m as the source of truth; higher timeframes are aggregated on read.
          ['15m'].forEach(tf => {
            const key = `${stock.symbol}_${tf}`;
            const lastBar = barMap.get(key);
            if (!lastBar) return;
            const tickVolume = Math.max(1, Math.min(MAX_KLINE_VOLUME, Math.round(stock.tickVolume || ((stock.volume || 1) * 1000))));

            const interval = tf === '15m' ? 15 * 60 * 1000 : tf === '1d' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
            const isNewBar = nowTs - lastBar.lastTs > interval;

            if (isNewBar) {
              const newTs = lastBar.lastTs + interval;
              const open = lastBar.close; // 無跳空：新 K 線的開盤價等於上一根的收盤價
              const high = Math.max(open, stock.price);
              const low = Math.min(open, stock.price);
              const close = stock.price;
              const volume = Math.min(MAX_KLINE_VOLUME, Math.round(tickVolume * randomInRange(2.5, 6.0)));
              const adjustedBar = smoothAdjacentOpenGap(lastBar.close, {
                timestamp: newTs,
                open: parseFloat(open.toFixed(2)),
                high: parseFloat(high.toFixed(2)),
                low: parseFloat(low.toFixed(2)),
                close: parseFloat(close.toFixed(2)),
                volume,
              });
              
              insertKLineStmt.run(stock.symbol, tf, newTs, adjustedBar.open, adjustedBar.high, adjustedBar.low, adjustedBar.close, volume);
            } else {
              // 更新最後一根 Bar
              const open = lastBar.open;
              const high = Math.max(lastBar.high, stock.price);
              const low = Math.min(lastBar.low, stock.price);
              const close = stock.price;
              const volume = Math.min(MAX_KLINE_VOLUME, Math.max(0, Number(lastBar.volume) || 0) + tickVolume);
              const adjustedBar = smoothAdjacentOpenGap(lastBar.close, {
                timestamp: lastBar.lastTs,
                open: parseFloat(open.toFixed(2)),
                high: parseFloat(high.toFixed(2)),
                low: parseFloat(low.toFixed(2)),
                close: parseFloat(close.toFixed(2)),
                volume,
              });

              updateKLineStmt.run(adjustedBar.open, adjustedBar.high, adjustedBar.low, adjustedBar.close, volume, stock.symbol, tf, lastBar.lastTs);
            }
          });
        });

        // 結束 Statements
        updateStockStmt.finalize();
        insertKLineStmt.finalize();
        updateKLineStmt.finalize((finErr) => {
          if (finErr) {
            db.run('ROLLBACK');
            return reject(finErr);
          }
          db.run('COMMIT', (commitErr) => {
            if (commitErr) return reject(commitErr);
            resolve();
          });
        });
      });
    });
  });
}

module.exports = {
  initDb,
  getStocks,
  getKLines,
  toggleFav,
  updateAllPricesAndKLines,
  db
};
