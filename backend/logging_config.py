import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path


LOG_DIR = Path(__file__).parent / "logs"
LOG_FORMAT = "%(asctime)s | %(levelname)s | %(name)s | %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


class PrefixFilter(logging.Filter):
    def __init__(self, prefix: str):
        super().__init__()
        self.prefix = prefix

    def filter(self, record: logging.LogRecord) -> bool:
        return record.name.startswith(self.prefix)


def configure_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    root_logger = logging.getLogger()
    if getattr(root_logger, "_quantx_logging_configured", False):
        return

    formatter = logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT)
    root_logger.setLevel(logging.INFO)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)

    backend_file_handler = RotatingFileHandler(
        LOG_DIR / "backend.log",
        maxBytes=2_000_000,
        backupCount=5,
        encoding="utf-8",
    )
    backend_file_handler.setFormatter(formatter)
    root_logger.addHandler(backend_file_handler)

    kline_file_handler = RotatingFileHandler(
        LOG_DIR / "kline.log",
        maxBytes=2_000_000,
        backupCount=5,
        encoding="utf-8",
    )
    kline_file_handler.setFormatter(formatter)
    kline_file_handler.addFilter(PrefixFilter("quantx.kline"))
    root_logger.addHandler(kline_file_handler)

    root_logger._quantx_logging_configured = True
    logging.getLogger("httpx").setLevel(logging.WARNING)
