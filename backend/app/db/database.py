from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from app.config import get_settings


class Base(DeclarativeBase):
    pass


def get_engine():
    settings = get_settings()
    return create_async_engine(settings.DATABASE_URL, echo=False)


def get_session_maker():
    engine = get_engine()
    return async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def init_db():
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_db():
    session_maker = get_session_maker()
    async with session_maker() as session:
        yield session
