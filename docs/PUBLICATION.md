# Publication preparation

Repository visibility and catalog releases are separate decisions. This cleanup
does not merge the development PR, bump plugin versions, regenerate release pins
or make the repository public.

The preparation audit on 2026-11-06 used Gitleaks **8.30.1**, with its default rules,
against all locally available Git refs. It reported **zero findings**. Source
screenshots were reviewed and contain only sample projects. Local test output,
dependencies and reference checkouts are ignored; tracked temporary scripts,
session plans and obsolete screenshots were removed. Third-party notices were
completed for bundled dependencies and the QML grammar. Both dependency trees have
committed lockfiles. CI checks source hygiene, secret patterns, types, bundles and
editor regressions. Rerun the audit after any further changes or fetched refs.

## Existing history and ownership

Existing commits contain a company-domain author/committer email. Deleting a file
in this branch does not remove earlier copies, author metadata, PR text or GitHub
caches. Review whether that history is acceptable before changing visibility.
Rewriting published commits requires a separate decision and coordinated force
push; a clean new repository is another option. Do not rewrite this history as
part of ordinary cleanup: catalog releases pin historical commit IDs and would
also need to be checked or regenerated against the chosen history.

The repository's own code is copyright **Tùng Vũ**, as confirmed by its author.
First-party licenses and plugin author metadata now use that personal name.
Upstream MIT/LGPL/BSD copyright and license notices remain intact.
The repository is not uniformly MIT: bundled third-party material retains its
own licenses, as listed in [README](../README.md#sources-and-licenses).

## Before changing visibility

1. Decide whether to retain the existing author/committer email in Git history.
2. Review the default branch and every branch/ref that will become public. Cleanup
   on a PR branch alone does not change the default branch or past commits.
3. Re-run `gitleaks git . --log-opts=--all --redact=100` on the fetched repository,
   then run [the contributor checks](../CONTRIBUTING.md).
4. Review GitHub issues, PR bodies/comments, Actions logs/artifacts, releases and
   attachments separately from Git file history. The file scan does not cover them.
5. Enable private vulnerability reporting if desired and update the repository's
   team-internal GitHub description when visibility is changed.

The catalog still publishes Code Intelligence **0.5.0** from its existing pinned
commit. The IDE/performance fixes in the development PR require their own reviewed,
versioned release before catalog installations receive them. Keep the catalog
commit IDs and content hashes consistent with the history being published.
