# Rules

### No std Mutex
Use `parking_lot::Mutex`; it does not poison.
