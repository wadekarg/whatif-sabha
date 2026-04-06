from sqlalchemy import Column, String, Text, JSON, DateTime, Float
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid
from app.db.database import Base


class Story(Base):
    __tablename__ = "stories"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    title = Column(String, nullable=True)
    author = Column(String, nullable=True)
    summary = Column(Text, nullable=True)
    themes = Column(JSON, default=list)

    pdf_path = Column(String, nullable=False)
    full_text = Column(Text, nullable=True)
    word_count = Column(Float, default=0)

    # Full structured analysis from LLM — characters, phases, events, relationships
    analysis = Column(JSON, nullable=True)

    # "uploaded" | "analyzing" | "ready" | "error"
    status = Column(String, default="uploaded")
    error_message = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    debates = relationship("Debate", back_populates="story", lazy="select")
