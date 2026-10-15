wire the new TenderController to list tenders
no. controllers never call a repository directly, they go through the service. TenderController injects TenderRepository, move that call into TenderService
