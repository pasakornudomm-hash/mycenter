# mycenter

## Record permissions

| Role | Create | Edit | Delete |
| --- | --- | --- | --- |
| ADMIN | Yes | Yes | Yes |
| MANAGER | Yes | Yes | Yes |
| STAFF | Yes | Yes (own records) | No |

STAFF deletion is blocked in the rendered UI, in the GitHub Pages API bridge, and
again by the deployed Google Apps Script backend.
