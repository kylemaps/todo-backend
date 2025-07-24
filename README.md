# Todo Backend Service

This repository contains the source code for the `todo-backend` API service.

## Purpose

This application provides the core REST API for the Todo application. It is responsible for:
*   Creating, reading, and updating todo items.
*   Persisting the data in a PostgreSQL database.
*   Publishing events to a NATS messaging server when todos are created or updated.

## Technology

*   **Framework**: Node.js with Koa and `koa-router`.
*   **Database**: PostgreSQL
*   **Eventing**: NATS (`todos.events` subject)

### Key Environment Variables

*   `POSTGRES_USER`: The username for the PostgreSQL database.
*   `POSTGRES_PASSWORD`: The password for the PostgreSQL database.
*   `POSTGRES_HOST`: The hostname of the PostgreSQL service.
*   `POSTGRES_DB`: The name of the database to use.
*   `NATS_URL`: The URL of the NATS messaging server.

---

*This is an application source code repository. The Kubernetes configuration for this service is managed in the central `todo-config` repository.*