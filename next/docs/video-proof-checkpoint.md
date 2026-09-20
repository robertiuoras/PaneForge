# PC video proof checkpoint

2026-09-21 (Brisbane): a synthetic one-second H.264 proof was encoded and decoded on the paired PC `DESKTOP-CMSUCM1`, through remote shell pane `@e38080cc645760c5/s9-mua03lzb`. The PC receipt reports FFmpeg/FFprobe 9.0, 160x90, duration 1.0 seconds, and video SHA-256 `50780796aca7f69589e236214e5680ac7906d1b4aeaf6ec036efb52fd4c651bb`.

Returned outbound archive: `/tmp/pc-next-video-proof-20260921-result.tar.gz`, SHA-256 `3a67414a5d8d465dfc8cda1bc6be77b619b9d60157c9d7ba8878c442619e2b02`. The Mac only checked the archive and byte hash; it did not render or decode video. This proves the paired PC can encode, decode, and return a bounded synthetic artifact, not PaneForge UI/video-rendering behavior.
