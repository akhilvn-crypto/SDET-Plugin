---
id: EXAMPLE-CHECKOUT-001
version: 1
name: Guest Checkout
entry_point:
  url: "<CHECKOUT_URL>"
---

# Guest Checkout

<!--
Markdown specs carry their identity in the YAML frontmatter above (id + version).
Bullet lists under each heading become the spec's requirement items, so keep one
testable statement per bullet. Describe intent, not implementation - no selectors.
-->

## Objective

- A guest shopper can buy an in-stock item without creating an account.

## Scenarios

- guest completes checkout with a valid card
- checkout is blocked when a required address field is empty
- an out-of-stock item cannot be purchased

## Security Checks

- payment details are never echoed back in full after submission

## Accessibility Checks

- the checkout form can be completed with the keyboard alone
