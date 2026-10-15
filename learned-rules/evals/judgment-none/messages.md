add the bid submission endpoint
why did you add a SELECT ... FOR UPDATE here? only lock when two writers can really race on the same row. a status move guarded by its UPDATE ... WHERE status = 'pending' doesn't need a lock
