# Updater gate fixtures

Recorded artifacts for `apps/desktop/two-signature-gate.test.ts`, four states of
one release, plus the public halves of the two keys that signed them.

| directory | what it records |
| --- | --- |
| `good` | artifact, its updater signature, its checksum, all matching |
| `tampered-artifact` | the bytes changed after the signature was made |
| `tampered-signature` | the signature's own bytes were edited |
| `wrong-key` | signed by a key the build does not trust |

The keys that signed these were generated for the fixtures and destroyed in the
same command. Neither private half exists anywhere. The project's real updater
key signs releases and nothing else: a test that needed it would be a test that
could only run on one machine, and a copy of that key in a fixture directory is
the way a signing key leaks.

Regenerating a fixture means generating two fresh throwaway keys, signing
`good`'s artifact with the first and `wrong-key`'s with the second, copying both
public halves here, and deleting the private halves. The artifact itself is a
text file on purpose: what the gate reads is bytes and a signature over them,
and a real 129 MB disk image in git would buy nothing.
