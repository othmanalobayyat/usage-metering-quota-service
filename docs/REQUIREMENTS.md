# Requirements — Usage Metering and Quota Service

## 1. Project Overview

**Estimated Time:** 42 hours  
**Timeline:** Beginning of 12/10/2026 – End of 20/10/2026 (1 week)  
**Technology Stack:** TypeScript, SQL, and PostgreSQL

Build a backend service that other applications can call to track usage and determine whether their users are allowed to perform an action. The service supports plans for both the calling application and its individual users.

For example, imagine a company running a document processing application. The company has a shared monthly allowance, and each user has an individual allowance. Before processing a document, the application's backend asks the service to consume units for a particular user. The service checks both allowances, records the decision, and counts the usage if the request is accepted.

The application can choose predefined plans or create and configure its own plans through the API. Changes to plan settings should take effect without redeploying the service.

One service and one database are sufficient for this project.

## 2. Product Assumptions

Some product behavior and business rules are intentionally left unspecified.

For cases the brief does not define:
- Choose sensible behavior.
- Document the assumption and its reasoning in the README.
- Continue implementing without waiting for clarification.
- Keep these choices consistent with the stated requirements.
- Apply them consistently throughout the service.

## 3. Accounts, Users, Plans, and Units

### 3.1. Account

An account represents an application or company calling the service.

- Each account has an account plan.
- The account plan defines limits shared by all its users.
- Each account must have its own API key.
- Each account's users and usage must remain separate from those of other accounts.

### 3.2. User

A user represents a user of an application registered under an account.

- Each user belongs to an account.
- Each user has a user plan.
- The user plan defines the user's individual limits.
- Users can have their plans assigned or changed.
- The service must validate that a supplied user belongs to the account identified by the API key.

### 3.3. Plan

A plan is a named set of configurable rules that can be assigned to an account or a user.

- An account has an account plan.
- Each user has a user plan.
- The account and user plans apply together.
- Several users may share the same plan definition while maintaining separate usage totals.
- Accounts can create, view, and update their own custom plans.
- Custom plans can be assigned to the account itself or to its users.
- Predefined plans can remain read-only.
- Plan settings must be changeable through the API without redeploying the service.

### 3.4. Units

Units represent the amount consumed by an action, such as document processing credits.

Use one resource throughout the project.

## 4. Authentication and Account Isolation

The calling application must supply an API key in a request header for operations involving an account and its users.

Requirements:

- Create accounts and issue an API key for each account.
- Use the API key to identify the calling account.
- Grant access only to the identified account's data.
- Reject requests with missing or invalid API keys.
- Validate that any supplied user belongs to the identified account.
- Keep each account's users and usage separate.

## 5. Core Features

### 5.1. Manage Accounts and Users

- Create accounts.
- Issue an API key for each account.
- Register users under accounts.
- Assign plans to accounts and users.
- Change account and user plans.
- Keep each account's users and usage separate from other accounts.

### 5.2. Provide Predefined Plans

Include ready-to-use plans for both accounts and users when the service starts.

Examples:

- **Starter:** Account plan.
- **Pro:** Account plan.
- **Basic:** User plan.
- **Premium:** User plan.

Choose sensible example limits and document them in the README.

### 5.3. Support Custom Plans

- Allow an account to create its own plans.
- Allow an account to view its own plans.
- Allow an account to update its own plans.
- Allow custom plans to be assigned to the account or its users.
- Allow several users to share the same plan definition.
- Maintain separate usage totals for each user, even when they share a plan.
- Predefined plans can remain read-only.
- Changes to plan settings must take effect without redeploying the service.

### 5.4. Consume Units

The service must accept a consumption request containing:

- A user identifier.
- A positive whole number of units.
- A request identifier.

The account must be identified through its API key.

The service must:

- Check all applicable account and user rules.
- Accept the full requested amount only if all applicable rules allow it.
- Reject the request if any applicable rule does not allow it.
- Consume nothing when a request is rejected.
- Record the request and its decision.
- Count usage when the request is accepted.

Giving a user a larger allowance does not increase the account's shared allowance.

### 5.5. Explain Decisions

- Return whether a consumption request was accepted or rejected.
- For a rejected request, identify the rule that prevented it.
- Identify whether the blocking rule belongs to the account or the user.
- Allow callers to inspect the plans and limits currently applied to each account and user.

### 5.6. Show Usage and History

The service must provide usage information for both accounts and users.

- Return consumed units.
- Return remaining units.
- Support usage information for the current month.
- Allow callers to view usage from previous months.
- Allow callers to view previous request outcomes.
- Provide request history.
- Support simple pagination for history.

### 5.7. Preserve Data

Store the following information in the database so it survives service restarts:

- Accounts.
- Users.
- Plans.
- Plan assignments.
- Usage records.
- Request history.

## 6. Expected Outcome

Deliver a backend service that allows calling applications to manage accounts and users, configure plans, consume units, enforce account-level and user-level limits, inspect usage and request history, and preserve all relevant data in PostgreSQL across restarts.