---
"@buildinternet/uploads": patch
---

Point to stranded staged files after a branch rename. When a branch's upstream is gone on origin, the staging note and `uploads staged` suggest `uploads attach --pr <num> --from-branch <branch>`. When `uploads attach --promote` finds nothing under the current branch, it lists the repo's other staged branches and the command to promote them.
