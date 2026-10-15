# Coding rules

### 1. Thin controllers
Controllers parse the request, delegate to a service and return. No business logic.

### 2. No subqueries
No EXISTS, IN (select ...), derived tables or scalar subselects in jOOQ; use joins or DISTINCT ON.

BAD: `.where(T.ID.in(select(U.T_ID).from(U)))`
GOOD: `.join(U).on(U.T_ID.eq(T.ID))`

### 3. Exceptions live in one package
Every exception class lives in `com.acme.models.exception`.
