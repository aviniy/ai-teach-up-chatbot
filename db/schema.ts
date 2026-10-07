import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    mode: text("mode").notNull(),
    turnsUsed: integer("turns_used").notNull().default(0),
    charsUsed: integer("chars_used").notNull().default(0),
    bonusTurns: integer("bonus_turns").notNull().default(0),
    bonusChars: integer("bonus_chars").notNull().default(0),
    messages: text("messages").notNull().default("[]"),
    pending: integer("pending", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [index("idx_sessions_updated_at").on(table.updatedAt)]
);
