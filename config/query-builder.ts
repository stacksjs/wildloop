import type { QueryBuilderOptions } from 'bun-query-builder'

// How queries behave, not which database they reach: the connection comes
// from config/database.ts (DB_DATABASE_PATH). A `database` named here once
// sent every model query in a QA run to database/stacks.sqlite.
const config: QueryBuilderOptions = {
  verbose: true,
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    defaultOrderColumn: 'created_at',
  },
  pagination: {
    defaultPerPage: 25,
    cursorColumn: 'id',
  },
  softDeletes: {
    enabled: false,
    column: 'deleted_at',
    defaultFilter: true,
  },
}

export default config
