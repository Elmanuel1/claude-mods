fix the tender search query, it's slow
don't use a subquery there, use a join. the IN (select ...) is why it's slow
