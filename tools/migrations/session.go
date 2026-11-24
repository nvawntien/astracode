package migrations

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync/atomic"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

var errSessionSpent = errors.New("migration database session cannot be replaced")

const migrationLockKey int64 = 0x4153545241434f44

type singleSessionConnector struct {
	driver.Connector
	used atomic.Bool
}

func (c *singleSessionConnector) Connect(ctx context.Context) (driver.Conn, error) {
	if !c.used.CompareAndSwap(false, true) {
		return nil, errSessionSpent
	}
	return c.Connector.Connect(ctx)
}

// openSingleSession keeps the advisory lock alive when Goose borrows the
// connection. If the server closes the session, the pool cannot replace it.
func openSingleSession(config pgx.ConnConfig) *sql.DB {
	config.Fallbacks = nil
	db := sql.OpenDB(&singleSessionConnector{Connector: stdlib.GetConnector(config)})
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db
}
