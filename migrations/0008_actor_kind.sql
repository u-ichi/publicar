ALTER TABLE comment_threads ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'human' CHECK (actor_kind IN ('human', 'ai'));
ALTER TABLE comment_replies ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'human' CHECK (actor_kind IN ('human', 'ai'));
