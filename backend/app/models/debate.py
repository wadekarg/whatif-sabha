from sqlalchemy import Column, String, Text, JSON, DateTime, ForeignKey, Integer
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid
from app.db.database import Base


class Debate(Base):
    __tablename__ = "debates"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    story_id = Column(String, ForeignKey("stories.id"), nullable=False)

    divergence_description = Column(Text, nullable=False)
    divergence_timeline_position = Column(String, nullable=True)  # e.g. "0.65"

    # Characters participating in this debate
    participating_characters = Column(JSON, default=list)

    # Full debate transcript — list of {character, message, round, timestamp}
    transcript = Column(JSON, default=list)

    # Final synthesized alternate ending
    alternate_ending = Column(Text, nullable=True)

    # Structured timeline of key events in the alternate world
    alternate_timeline = Column(JSON, nullable=True)

    # Structured alternate world state — queryable by Oracle mode
    # { characters: {name: {survived, new_role, new_beliefs, ...}}, world_state: {...}, new_events: [...] }
    alternate_world_state = Column(JSON, nullable=True)

    # "pending" | "running" | "completed" | "error"
    status = Column(String, default="pending")

    round_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)

    story = relationship("Story", back_populates="debates")
