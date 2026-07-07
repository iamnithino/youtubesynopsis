import os

from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from models import Base

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./synopsis.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base.metadata.create_all(bind=engine)


def add_missing_summary_columns():
    inspector = inspect(engine)
    if "summaries" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("summaries")}
    columns = {
        "title": "VARCHAR",
        "channel": "VARCHAR",
        "duration": "INTEGER",
        "thumbnail": "VARCHAR",
        "caption_segments": "JSON",
        "caption_summaries": "JSON",
        "chapters": "JSON",
        "key_points": "JSON",
        "questions": "JSON",
        "action_items": "JSON",
        "language": "VARCHAR",
    }

    with engine.begin() as connection:
        for name, column_type in columns.items():
            if name not in existing_columns:
                connection.execute(text(f"ALTER TABLE summaries ADD COLUMN {name} {column_type}"))


add_missing_summary_columns()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
