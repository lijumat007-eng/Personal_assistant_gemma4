# Expressive robot prototype

RobotExpressive.glb is a CC0 1.0 character by Tomás Laulhé (Quaternius).
Don McCurdy added Angry, Surprised, and Sad morph targets and optimized the file.
The original README is preserved beside the model.

Source: https://github.com/mrdoob/three.js/tree/r180/examples/models/gltf/RobotExpressive
CC0: https://creativecommons.org/publicdomain/zero/1.0/
Model SHA-256: 047f5e5fb3bb6d378bd1df16ca6137f2a596c99b3a1b5690b4020c05aaf6f319

Three.js 0.180.0 is vendored under ../../vendor/three with its MIT LICENSE.
GLTFLoader and BufferGeometryUtils imports are rewritten to relative paths so
the browser loads everything locally, without a build step or a new CDN policy.

This prototype uses browser speech synthesis. The illuminated mouth is a
procedural effect driven by speech start/end/error events, not phoneme lip sync.
Local Kokoro synthesis and uploaded avatars remain future phases. An optional
floating Windows shell now wraps this same renderer in desktop-companion/.
