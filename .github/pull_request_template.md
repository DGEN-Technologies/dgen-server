## Description

<!-- Describe your changes -->

## Security Checklist

<!-- Check all that apply -->

### Changes to Sensitive Code

- [ ] This PR modifies `lib/db.ts` (database connections)
- [ ] This PR modifies `lib/auth.ts` (authentication)
- [ ] This PR modifies `config.ts` or environment handling
- [ ] This PR modifies rate limiting or security middleware
- [ ] This PR adds new dependencies

### Security Review

- [ ] No SQL/NoSQL injection vulnerabilities
- [ ] All user inputs are properly validated
- [ ] No sensitive data logged to console
- [ ] No secrets committed to repository
- [ ] Authentication/authorization properly enforced
- [ ] Rate limiting appropriate for new endpoints
- [ ] Dependencies scanned for vulnerabilities

### Testing

- [ ] Unit tests added/updated
- [ ] Tested with Redis connected/disconnected
- [ ] Tested in production-like environment
- [ ] No unhandled promise rejections

## Reviewer Notes

<!-- Additional context for reviewers -->
