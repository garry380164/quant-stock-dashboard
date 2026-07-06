FROM python:3.11-slim

# 設定工作目錄
WORKDIR /app

# 安裝編譯相依套件 (部分 Python 套件編譯需要，例如 sqlite3 相關套件)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 複製 requirements.txt
COPY requirements.txt .

# 安裝 Python 相依套件
RUN pip install --no-cache-dir -r requirements.txt

# 複製後端程式碼至 /app/backend
COPY . /app/backend

# 設定環境變數
ENV PYTHONUNBUFFERED=1
ENV PORT=8080

# 預先建立資料庫與日誌儲存路徑
RUN mkdir -p /data /app/backend/logs

# 暴露連接埠
EXPOSE 8080

# 啟動命令 (注意：這裡使用 uvicorn 啟動 FastAPI，Fly.io 會將 backend 加入 python path)
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080"]
