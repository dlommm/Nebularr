# Branding

## Product Name

- **Nebularr**

## Asset usage map

```mermaid
flowchart LR
  icon[nebularr-icon.svg]
  banner[nebularr-logo.svg]
  readmePng[docs/readme/nebularr-banner.png]
  sidebar[WebUI sidebar mark]
  welcome[Overview welcome card]
  readme[README banner]
  icon --> sidebar
  banner --> welcome
  banner -.raster export.-> readmePng
  readmePng --> readme
```

## Logo

![Nebularr logo](../src/arrsync/web/assets/nebularr-logo.svg)

## Brand Intent

- "Nebula" reflects broad media telemetry and discovery.
- "arr" aligns with Sonarr/Radarr ecosystem naming.
- Visual style is dark-theme friendly and matches the app control-plane UI.
