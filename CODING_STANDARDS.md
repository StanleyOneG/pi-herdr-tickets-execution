# Universal Development Principles for AI Agents

This document defines language-agnostic coding standards, architectural patterns, and development principles for AI agents writing code. These principles ensure clean, maintainable, secure, and production-ready code in **any** statically or dynamically typed language.

When working in a specific language, adapt these principles to its idiomatic conventions. The patterns below are universal — the syntax changes, the discipline does not.

**Important for AI agents**: These rules are precise and non-negotiable. If a principle seems inconvenient for a particular feature, the feature implementation must bend to the principle, not the other way around. Scaling a shortcut across a codebase creates systemic failure.

---

## Table of Contents

1. [Clean Architecture](#clean-architecture)
2. [Dependency Injection](#dependency-injection)
3. [Interface-Based Design (Ports and Adapters)](#interface-based-design-ports-and-adapters)
4. [Data Access Patterns](#data-access-patterns)
5. [Data Transfer Objects and Validation](#data-transfer-objects-and-validation)
6. [Error Handling with Result Type](#error-handling-with-result-type)
7. [Service Layer Patterns](#service-layer-patterns)
8. [API Layer Patterns](#api-layer-patterns)
9. [Cross-Cutting Concerns](#cross-cutting-concerns)
10. [Asynchronous Programming Patterns](#asynchronous-programming-patterns)
11. [Security Principles](#security-principles)
12. [Type System Guidelines](#type-system-guidelines)
13. [Naming Conventions](#naming-conventions)
14. [Code Organization](#code-organization)
15. [Testing Patterns](#testing-patterns)
16. [Logging and Observability](#logging-and-observability)

---

## Clean Architecture

### Concentric Layer Model

Clean Architecture organizes code into concentric layers. **Every dependency arrow points inward.** Outer layers know about inner layers. Inner layers know nothing about outer layers. This is the **Dependency Inversion Principle** — the foundation of the entire architecture.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INFRASTRUCTURE                               │
│         Frameworks, Drivers, DB, External APIs, File I/O            │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                   INTERFACE ADAPTERS                         │   │
│   │       Presentation (Controllers/Routes), Repository          │   │
│   │       Implementations, Gateways, Error Mappers               │   │
│   │                                                             │   │
│   │   ┌─────────────────────────────────────────────────────┐   │   │
│   │   │               APPLICATION LAYER                      │   │   │
│   │   │        Use Cases, Application Services               │   │   │
│   │   │   Defines Port Interfaces (Repository Contracts)     │   │   │
│   │   │                                                     │   │   │
│   │   │   ┌─────────────────────────────────────────────┐   │   │   │
│   │   │   │              DOMAIN LAYER                    │   │   │   │
│   │   │   │    Entities, Value Objects, Domain Services  │   │   │   │
│   │   │   │    Domain Errors, Business Rules             │   │   │   │
│   │   │   │                                             │   │   │   │
│   │   │   │         *** DEPENDS ON NOTHING ***           │   │   │   │
│   │   │   └─────────────────────────────────────────────┘   │   │   │
│   │   └─────────────────────────────────────────────────────┘   │   │
│   └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘

All dependency arrows point INWARD. Never outward.
```

### Hexagonal (Ports & Adapters) View

The same architecture viewed as a hexagon clarifies how external systems connect through ports:

```
                          Inbound (Driving) Side
                    ┌──────────────────────────────┐
                    │                              │
     ┌──────────┐  │   ┌────────────────────┐     │  ┌──────────┐
     │   HTTP   │──┼──▶│    <<port>>        │     │  │          │
     │ Controller│  │   │ CreateOrderUseCase │     │  │ Postgres │
     └──────────┘  │   └────────┬───────────┘     │  │    DB    │
                    │            │                  │  └────▲─────┘
     ┌──────────┐  │            ▼                  │       │
     │   CLI    │──┼──▶┌────────────────────┐      │  ┌────┴──────────┐
     │ Handler  │  │   │                    │      │  │  <<adapter>>  │
     └──────────┘  │   │   DOMAIN CORE      │      │  │  PostgresOrder│
                    │   │                    │──────┼─▶│  Repository   │
     ┌──────────┐  │   │  Entities          │      │  └───────────────┘
     │  gRPC    │──┼──▶│  Value Objects     │      │
     │ Handler  │  │   │  Domain Services   │      │  ┌───────────────┐
     └──────────┘  │   │  Business Rules    │      │  │  <<adapter>>  │
                    │   │                    │──────┼─▶│  EmailNotif   │
     ┌──────────┐  │   └────────┬───────────┘      │  │  Gateway      │
     │  Event   │──┼──▶│    <<port>>        │      │  └────▲─────────-┘
     │ Consumer │  │   │ OrderRepository    │      │       │
     └──────────┘  │   └────────────────────┘      │  ┌────┴─────┐
                    │                              │  │  SMTP    │
                    └──────────────────────────────┘  │  Server  │
                          Outbound (Driven) Side      └──────────┘

Left side:  INBOUND adapters (drive the application)
Right side: OUTBOUND adapters (driven by the application)
Center:     DOMAIN CORE + APPLICATION USE CASES define ports
```

### Layer Responsibilities and Dependency Rules

| Layer | Responsibility | Can Depend On | NEVER Depends On |
|-------|---------------|---------------|------------------|
| **Domain** (center) | Entities, Value Objects, Domain Services, Domain Errors, Business Rules | **Nothing** | Application, Adapters, Infrastructure |
| **Application** (Use Cases) | Orchestration, application-specific rules. **Defines port interfaces** (repository contracts, external service contracts) | Domain only | Adapters, Infrastructure |
| **Interface Adapters** (outer) | Controllers/Routes, Repository *implementations*, error mappers, DTO ↔ Domain mapping | Application, Domain | Infrastructure details |
| **Infrastructure** (outermost) | Frameworks, database drivers, HTTP clients, message brokers, file I/O | All inner layers (implements their interfaces) | — |

### The Dependency Inversion Rule

The critical insight: **the Application layer defines interfaces (ports), and the Infrastructure layer implements them (adapters).**

```
// The Application layer DEFINES what it needs:
// (This interface lives in the application/ports/ directory)
interface OrderRepository:                    // PORT — defined by the core
    getById(orderId: UUID) -> Order?
    create(command: CreateOrderCommand) -> Order

// The Infrastructure layer PROVIDES the implementation:
// (This class lives in the adapters/outbound/ directory)
class PostgresOrderRepository implements OrderRepository:   // ADAPTER
    private db: DatabaseClient
    getById(orderId: UUID) -> Order?:
        ...
```

**Correct** — Controller depends on Use Case, Use Case defines its own port:
```
// Controller (Adapter layer) → Use Case (Application layer)
// Use Case defines OrderRepository interface
// PostgresOrderRepository (Infrastructure) implements that interface
// The Use Case never imports anything from Infrastructure
```

**Incorrect** — Use Case imports from Infrastructure:
```
// WRONG: Use Case importing a concrete database client
import PostgresClient from "infrastructure/database"   // VIOLATION
```

### Recommended Directory Structure

```
project_name/
├── main.*                          # Entry point + composition root
├── domain/                         # CENTER — depends on nothing
│   ├── entities.*                 # Core business objects
│   ├── value_objects.*            # Immutable, self-validating domain primitives
│   ├── errors.*                   # Domain error types (transport-agnostic)
│   └── services.*                 # Domain services (pure business logic)
├── application/                    # USE CASES — depends on Domain only
│   ├── ports/                     # Interfaces defined by the application
│   │   ├── repositories.*        # Repository port interfaces
│   │   ├── external_services.*   # External service port interfaces
│   │   ├── clock.*               # Time provider port
│   │   └── id_generator.*        # ID generation port
│   ├── commands.*                 # Command objects (input to use cases)
│   ├── queries.*                  # Query objects (input to read use cases)
│   ├── use_cases/
│   │   ├── create_order.*
│   │   └── process_payment.*
│   └── services.*                 # Application services
├── adapters/                       # INTERFACE ADAPTERS
│   ├── inbound/                   # Driving adapters (receive requests)
│   │   ├── http/                  # HTTP controllers/routes
│   │   │   ├── v1/
│   │   │   │   ├── users.*
│   │   │   │   └── orders.*
│   │   │   ├── error_mapper.*    # Maps domain errors → HTTP responses
│   │   │   └── dto/              # Request/Response DTOs (HTTP-specific)
│   │   │       ├── requests.*
│   │   │       └── responses.*
│   │   ├── cli/                   # CLI handlers (if applicable)
│   │   └── grpc/                  # gRPC handlers (if applicable)
│   └── outbound/                  # Driven adapters (call external systems)
│       ├── persistence/           # Repository implementations
│       │   ├── postgres_user_repository.*
│       │   ├── postgres_order_repository.*
│       │   └── queries/           # Raw SQL / ORM queries
│       ├── messaging/             # Message broker adapters
│       ├── external_apis/         # Third-party API clients
│       ├── system_clock.*         # Clock port implementation
│       └── uuid_generator.*       # IdGenerator port implementation
├── infrastructure/                 # OUTERMOST — framework config, DI
│   ├── config.*                   # Configuration loading
│   ├── di_container.*             # Dependency injection setup
│   └── database.*                 # Database connection setup
└── tests/
    ├── shared_fixtures.*
    ├── fakes/                     # Fake implementations of ports
    ├── unit/
    └── integration/
```

---

## Dependency Injection

### Core Principle

Components receive their dependencies through constructors (or initializers), never by creating them internally. The **composition root** (typically `main.*` or `di_container.*`) is the only place where concrete implementations are chosen and wired together.

### Provider Organization

Group DI registrations by architectural layer:

```
// Pseudocode

InfrastructureProviders:
    provides Settings            (app-scoped / singleton)
    provides DatabaseConnection  (app-scoped / singleton)
    provides DatabaseClient      (app-scoped / singleton)
    provides Clock               (app-scoped)   // concrete: SystemClock
    provides IdGenerator         (app-scoped)   // concrete: UUIDGenerator

AdapterProviders:
    provides OrderRepository     (app-scoped)   // concrete: PostgresOrderRepository
    provides UserRepository      (app-scoped)   // concrete: PostgresUserRepository
    provides NotificationGateway (app-scoped)   // concrete: EmailNotificationGateway

ApplicationProviders:
    provides CreateOrderUseCase  (request-scoped)
    provides GetOrderUseCase     (request-scoped)
    provides OrderService        (request-scoped)
```

### Scope Guidelines

| Scope | Lifetime | Use For |
|-------|----------|---------|
| App / Singleton | Application lifetime | Settings, DB connection pools, HTTP clients, thread pools, Clock, IdGenerator |
| Request / Transient | Per HTTP request | Use cases, services, request-scoped state |
| Session | Custom lifetime | User sessions, WebSocket connections |

### Language-Specific DI Approaches

Choose the idiomatic approach for the target language:

| Language | Idiomatic Approach |
|----------|-------------------|
| Swift | Constructor injection; protocol-based; Swinject for complex graphs |
| Go | Constructor injection; pass dependencies explicitly; Wire for compile-time DI |
| TypeScript | NestJS built-in; tsyringe; InversifyJS; manual constructor injection |
| Kotlin | Constructor injection; Koin; Hilt/Dagger for Android |
| C# | Microsoft.Extensions.DependencyInjection; constructor injection |
| Python | Dishka; dependency-injector; manual constructor injection |
| Java | Spring DI; Guice; Dagger; constructor injection |
| Rust | Constructor injection; no framework typically needed |

### Lifecycle Management

Always ensure resources are cleaned up on shutdown:

```
// Pseudocode
application_lifecycle:
    on_startup:
        log("Starting application")
        initialize_container()

    on_shutdown:
        close_container()     // releases DB connections, HTTP clients, etc.
```

---

## Interface-Based Design (Ports and Adapters)

### Ports: Define Interfaces in the Application Layer

The Application layer defines **port interfaces** — contracts for what it needs from the outside world. These interfaces live alongside the use cases, not with the implementations.

```
// FILE: application/ports/repositories.*

// The Application layer declares what it needs
interface UserRepository:                      // PORT
    getById(userId: UUID) -> User?
    getByEmail(email: String) -> User?
    create(command: CreateUserCommand) -> User
    update(userId: UUID, command: UpdateUserCommand) -> User
    delete(userId: UUID) -> Boolean
```

### Adapters: Implement Interfaces in the Outer Layers

The Infrastructure/Adapter layer **implements** the port, pointing its dependency inward:

```
// FILE: adapters/outbound/persistence/postgres_user_repository.*

class PostgresUserRepository implements UserRepository:   // ADAPTER
    private db: DatabaseClient

    constructor(db: DatabaseClient):
        this.db = db

    getById(userId: UUID) -> User?:
        result = this.db.queryOne("SELECT * FROM users WHERE id = ?", userId)
        return result != null ? User.fromRow(result) : null

    getByEmail(email: String) -> User?:
        result = this.db.queryOne("SELECT * FROM users WHERE email = ?", email)
        return result != null ? User.fromRow(result) : null

    create(command: CreateUserCommand) -> User:
        result = this.db.queryOne(
            "INSERT INTO users (email, name) VALUES (?, ?) RETURNING *",
            command.email, command.name
        )
        return User.fromRow(result)
```

### Hidden Dependencies: Time and Randomness

**Critical rule**: Never call `now()`, `new Date()`, `UUID.random()`, or any non-deterministic function directly inside the Domain or Application layers. These are **implicit dependencies** that silently break deterministic testing.

Instead, inject them as port interfaces:

```
// FILE: application/ports/clock.*
interface Clock:                               // PORT
    now() -> DateTime

// FILE: application/ports/id_generator.*
interface IdGenerator:                         // PORT
    generate() -> UUID

// FILE: adapters/outbound/system_clock.*
class SystemClock implements Clock:            // ADAPTER — production
    now() -> DateTime:
        return DateTime.currentUTC()

// FILE: adapters/outbound/uuid_generator.*
class UUIDGenerator implements IdGenerator:    // ADAPTER — production
    generate() -> UUID:
        return UUID.randomV4()

// FILE: tests/fakes/fake_clock.*
class FakeClock implements Clock:              // FAKE — tests
    private fixedTime: DateTime

    constructor(fixedTime: DateTime):
        this.fixedTime = fixedTime

    now() -> DateTime:
        return this.fixedTime

    // Test helper: advance time
    advance(duration: Duration):
        this.fixedTime = this.fixedTime + duration

// FILE: tests/fakes/fake_id_generator.*
class FakeIdGenerator implements IdGenerator:  // FAKE — tests
    private nextId: UUID

    constructor(nextId: UUID):
        this.nextId = nextId

    generate() -> UUID:
        return this.nextId

    setNext(id: UUID):
        this.nextId = id
```

Usage in business logic:

```
// CORRECT — time and randomness are injected
class OrderServiceImpl:
    private clock: Clock
    private idGen: IdGenerator

    createOrder(command: CreateOrderCommand) -> OrderResult:
        order = Order(
            id: this.idGen.generate(),          // injectable, testable
            createdAt: this.clock.now(),         // injectable, testable
            ...
        )
```

```
// WRONG — hidden dependency, untestable
class OrderServiceImpl:
    createOrder(command: CreateOrderCommand) -> OrderResult:
        order = Order(
            id: UUID.random(),                  // HIDDEN DEPENDENCY
            createdAt: DateTime.now(),           // HIDDEN DEPENDENCY
            ...
        )
```

### Language-Specific Interface Mechanisms

| Language | Mechanism | Example |
|----------|-----------|---------|
| Swift | `protocol` | `protocol UserRepository { ... }` |
| Go | `interface` | `type UserRepository interface { ... }` |
| TypeScript | `interface` | `interface UserRepository { ... }` |
| Kotlin | `interface` | `interface UserRepository { ... }` |
| C# | `interface` | `interface IUserRepository { ... }` |
| Python | `Protocol` | `class UserRepositoryProtocol(Protocol): ...` |
| Java | `interface` | `interface UserRepository { ... }` |
| Rust | `trait` | `trait UserRepository { ... }` |

### Benefits

1. **Loose coupling**: The core never knows which database, clock, or ID scheme is used
2. **Testability**: Swap PostgresUserRepository for FakeUserRepository, SystemClock for FakeClock
3. **Flexibility**: Switch from Postgres to MongoDB by writing a new adapter — zero changes to business logic
4. **Transport agnosticism**: The same Use Case works behind HTTP, CLI, gRPC, or a message consumer
5. **Deterministic tests**: Controlling time and IDs means tests produce identical results every run

---

## Data Access Patterns

### Repository Pattern (Port + Adapter)

The repository **interface (port)** lives in the Application layer. The **implementation (adapter)** lives in the outer layer:

```
// PORT — application/ports/repositories.*
interface OrderRepository:
    getById(orderId: UUID) -> Order?
    getByUser(userId: UUID, pagination: Pagination) -> PaginatedResult<Order>
    create(command: CreateOrderCommand) -> Order
    updateStatus(orderId: UUID, status: OrderStatus) -> Order

// ADAPTER — adapters/outbound/persistence/postgres_order_repository.*
class PostgresOrderRepository implements OrderRepository:
    private db: DatabaseClient

    constructor(db: DatabaseClient):
        this.db = db

    getById(orderId: UUID) -> Order?:
        return queryOrderById(this.db, orderId)

    getByUser(userId: UUID, pagination: Pagination) -> PaginatedResult<Order>:
        return queryOrdersByUser(this.db, userId, pagination)

    create(command: CreateOrderCommand) -> Order:
        return insertOrder(this.db, command)
```

### Mandatory Pagination for Collections

**Critical rule**: Any repository method, use case, or API endpoint that returns a collection **must** accept pagination parameters and return a paginated result. Unbounded queries will eventually load millions of rows into memory and crash the service.

```
// Pagination input — used in commands/queries
class Pagination:
    limit: PositiveInteger          // max items per page, with a hard ceiling (e.g., 100)
    cursor: String?                 // opaque cursor for cursor-based pagination
    // OR
    offset: NonNegativeInteger      // for offset-based pagination

// Paginated result — returned by repositories and use cases
class PaginatedResult<T>:
    items: List<T>
    nextCursor: String?             // null if no more pages (cursor-based)
    totalCount: Integer?            // optional, expensive to compute for large datasets
    hasMore: Boolean
```

Apply this rule everywhere collections appear:

```
// Repository port
interface OrderRepository:
    getByUser(userId: UUID, pagination: Pagination) -> PaginatedResult<Order>
    // NEVER: getByUser(userId: UUID) -> List<Order>  ← unbounded, will crash

// Use Case
interface ListUserOrdersUseCase:
    execute(query: ListUserOrdersQuery) -> Result<PaginatedResult<Order>, DomainError>

// API endpoint
endpoint GET "/users/{userId}/orders?limit=20&cursor=abc":
    // Always returns a bounded page, never an unbounded list
```

### Query Separation

Keep raw queries in separate files, separate from the repository class:

```
adapters/outbound/persistence/
├── postgres_order_repository.*    # Repository adapter class
└── queries/
    ├── order_queries.*            # Query functions
    └── user_queries.*
```

### Unit of Work Pattern

Transaction management belongs behind an interface. Use Cases control transaction boundaries without knowing the database implementation:

```
// PORT — application/ports/unit_of_work.*
interface UnitOfWork:
    begin() -> void
    commit() -> void
    rollback() -> void

// Usage in a Use Case:
class CreateOrderWithItemsUseCase:
    private unitOfWork: UnitOfWork
    private orderRepo: OrderRepository
    private itemRepo: OrderItemRepository

    execute(command: CreateOrderCommand) -> OrderResult:
        this.unitOfWork.begin()
        try:
            order = this.orderRepo.create(command)
            items = this.itemRepo.createBulk(order.id, command.items)
            this.unitOfWork.commit()
            return Result.ok(OrderWithDetails(order, items))
        catch:
            this.unitOfWork.rollback()
            rethrow
```

The `UnitOfWork` implementation lives in Infrastructure and wraps the actual database transaction.

### Connection Management

Use DI for connection lifecycle — never manage connections manually in business code:

```
// Pseudocode — Infrastructure layer
DatabaseProvider:
    provides ConnectionPool (app-scoped):
        return createPool(dsn: settings.databaseUrl, minSize: 5, maxSize: 20)

    provides Connection (request-scoped):
        connection = pool.acquire()
        yield connection
        connection.release()
```

---

## Data Transfer Objects and Validation

### DTOs Belong ONLY in the Presentation Layer

**Critical rule**: DTOs are transport-specific data shapes (JSON, XML, gRPC messages). They must **never** penetrate into the Application or Domain layers.

The data flow is:

```
Inbound:   RequestDTO → [Mapper in Controller] → Domain Command → Use Case
Outbound:  Use Case → Domain Result → [Mapper in Controller] → ResponseDTO
```

### Request DTOs (Presentation Layer Only)

```
// FILE: adapters/inbound/http/dto/requests.*

class CreateOrderRequestDTO:
    userId: UUID
    items: List<OrderItemRequestDTO>
    shippingAddress: AddressDTO
    notes: String?                         // optional, max 500 chars

    validate():
        assert items.length >= 1, "Order must contain at least one item"
```

### Domain Commands (Application Layer)

The Presentation layer maps the DTO into a pure domain command:

```
// FILE: application/commands.*

class CreateOrderCommand:
    actorId: UUID                          // who is making this request
    userId: UUID
    items: List<OrderItem>                 // domain value objects, not DTOs
    shippingAddress: Address               // domain value object
    notes: String?
```

### The Mapping Happens in the Controller

```
// FILE: adapters/inbound/http/v1/orders.*

endpoint POST "/orders":
    requestDTO: CreateOrderRequestDTO       // transport-specific
    authenticatedUser: AuthContext           // from auth middleware

    // MAP: DTO → Domain Command
    command = CreateOrderCommand(
        actorId: authenticatedUser.userId,
        userId: requestDTO.userId,
        items: requestDTO.items.map(OrderItem.fromDTO),
        shippingAddress: Address.fromDTO(requestDTO.shippingAddress),
        notes: requestDTO.notes
    )

    result = useCase.execute(command)

    // MAP: Domain Result → Response DTO
    if result.isErr():
        return errorMapper.toHttpResponse(result.error)

    return OrderResponseDTO.fromDomain(result.unwrap())
```

### Response DTOs (Presentation Layer Only)

```
// FILE: adapters/inbound/http/dto/responses.*

class OrderResponseDTO:
    id: UUID
    userId: UUID
    status: String
    total: Decimal
    items: List<OrderItemResponseDTO>
    createdAt: DateTime
    updatedAt: DateTime?

    static fromDomain(order: Order) -> OrderResponseDTO:
        return OrderResponseDTO(
            id: order.id,
            status: order.status.value,
            ...
        )
```

### Value Objects: Self-Validating Domain Primitives

**Critical rule**: A Value Object must **never** exist in an invalid state. It validates its own invariants upon creation and is immutable thereafter. If instantiation receives invalid data, it must fail immediately with a domain error — not silently store garbage.

```
// FILE: domain/value_objects.*

// A valid email address — or it doesn't exist at all
class EmailAddress:
    private value: String

    constructor(raw: String):
        normalized = raw.trim().lowercase()
        if not containsChar(normalized, '@'):
            throw DomainError(code: VALIDATION_FAILED, message: "Invalid email format")
        if normalized.length > 254:
            throw DomainError(code: VALIDATION_FAILED, message: "Email too long")
        this.value = normalized

    toString() -> String:
        return this.value

// A positive monetary amount — or it doesn't exist at all
class PositiveDecimal:
    private value: Decimal

    constructor(raw: Decimal):
        if raw <= 0:
            throw DomainError(code: VALIDATION_FAILED, message: "Amount must be positive")
        this.value = raw

    toDecimal() -> Decimal:
        return this.value

// Enumerations as value objects
enum OrderStatus:
    PENDING, CONFIRMED, PROCESSING, SHIPPED, DELIVERED, CANCELLED

enum PaymentMethod:
    CREDIT_CARD, DEBIT_CARD, BANK_TRANSFER, CRYPTO
```

This guarantees that any code receiving an `EmailAddress` or `PositiveDecimal` can trust it is valid without re-checking.

### Validation Layers Summary

| What | Where | Examples |
|------|-------|---------|
| **Syntactic validation** (format, length, range) | Request DTO in the Presentation layer | JSON schema, field length, regex |
| **Domain invariants** (must always be true) | Value Object constructor in the Domain layer | `EmailAddress` requires `@`, `PositiveDecimal` requires `> 0` |
| **Business rules** (context-dependent) | Use Case or Domain Service | User must be active, stock must be available |

---

## Error Handling with Result Type

### Core Concept

Use a **Result type** to make errors explicit in function signatures instead of relying on thrown exceptions for control flow. The Result type forces callers to handle both success and failure cases.

### Domain Errors Are Transport-Agnostic

**Critical rule**: Domain errors must **never** know about HTTP, gRPC, or any transport protocol. Domain errors are pure data — an error code and a message. The Presentation layer is solely responsible for mapping domain errors to transport-specific responses.

```
// FILE: domain/errors.*
// These errors know NOTHING about HTTP status codes.

enum ErrorCode:
    NOT_FOUND
    VALIDATION_FAILED
    CONFLICT
    EXTERNAL_SERVICE_FAILURE
    AUTHORIZATION_DENIED

class DomainError:
    code: ErrorCode
    message: String
    originalError: Error?        // optional, for wrapping lower-level errors

// Specific error constructors (optional convenience):
function notFound(message: String) -> DomainError:
    return DomainError(code: ErrorCode.NOT_FOUND, message: message)

function validationFailed(message: String) -> DomainError:
    return DomainError(code: ErrorCode.VALIDATION_FAILED, message: message)

function conflict(message: String) -> DomainError:
    return DomainError(code: ErrorCode.CONFLICT, message: message)

function externalFailure(message: String, cause: Error?) -> DomainError:
    return DomainError(code: ErrorCode.EXTERNAL_SERVICE_FAILURE,
                       message: message, originalError: cause)

function authorizationDenied(message: String) -> DomainError:
    return DomainError(code: ErrorCode.AUTHORIZATION_DENIED, message: message)
```

### Error Mapping in the Presentation Layer

The **Presentation layer** (and only this layer) maps domain errors to HTTP responses:

```
// FILE: adapters/inbound/http/error_mapper.*
// This is the ONLY place that knows about HTTP status codes.

class HttpErrorMapper:
    toHttpResponse(error: DomainError) -> HttpResponse:
        match error.code:
            ErrorCode.NOT_FOUND:
                return HttpResponse(status: 404, body: {detail: error.message})
            ErrorCode.VALIDATION_FAILED:
                return HttpResponse(status: 400, body: {detail: error.message})
            ErrorCode.CONFLICT:
                return HttpResponse(status: 409, body: {detail: error.message})
            ErrorCode.EXTERNAL_SERVICE_FAILURE:
                return HttpResponse(status: 503, body: {detail: error.message})
            ErrorCode.AUTHORIZATION_DENIED:
                return HttpResponse(status: 403, body: {detail: error.message})
```

If you later add a CLI adapter, you write a `CliErrorMapper`. If you add gRPC, you write a `GrpcErrorMapper`. The domain errors remain unchanged.

### Result Type Structure

```
// Pseudocode — generic Result type
type Result<Value, Error>:
    case ok(value: Value)
    case err(error: Error)

    isOk() -> Boolean
    isErr() -> Boolean
    unwrap() -> Value                   // throws/panics if error
    unwrapOr(default: Value) -> Value   // returns default if error
    map(fn: Value -> NewValue) -> Result<NewValue, Error>
    mapErr(fn: Error -> NewError) -> Result<Value, NewError>

    static ok(value: Value) -> Result<Value, Error>
    static err(error: Error) -> Result<Value, Error>
```

### Language-Specific Result Types

| Language | Built-in / Idiomatic | Library Alternative |
|----------|---------------------|---------------------|
| Rust | `Result<T, E>` (native) | — |
| Swift | `Result<Success, Failure>` (native) | — |
| Kotlin | `Result<T>` (stdlib) | Arrow `Either<E, A>` |
| Go | `(value, error)` multi-return | — |
| TypeScript | Discriminated union | `neverthrow` library |
| C# | Exceptions (idiomatic) | `ErrorOr`, `FluentResults`, `LanguageExt` |
| Python | Custom `Result` class | `returns` library |
| Java | Exceptions (idiomatic) | `vavr` `Either`/`Try` |

**Note**: When the language convention is exceptions (C#, Java), still design services to return structured errors from business logic. Use exceptions at infrastructure boundaries, use result types or structured error returns within the service and application layers.

### Type Aliases for Domain Results

```
// Pseudocode
type OrderResult = Result<Order, DomainError>
type UserResult = Result<User, DomainError>
```

---

## Service Layer Patterns

### Use Case Structure

A Use Case orchestrates a **single application operation**. It receives a domain command (not a DTO), coordinates domain services, and returns a domain result (not a response DTO).

```
// FILE: application/use_cases/create_order.*

interface CreateOrderUseCase:
    execute(command: CreateOrderCommand) -> OrderResult

class CreateOrderUseCaseImpl implements CreateOrderUseCase:
    private orderService: OrderService
    private userRepo: UserRepository

    constructor(orderService: OrderService, userRepo: UserRepository):
        this.orderService = orderService
        this.userRepo = userRepo

    execute(command: CreateOrderCommand) -> OrderResult:
        // 1. Authorize: verify the actor has permission
        if command.actorId != command.userId:
            actorPermission = this.userRepo.hasAdminRole(command.actorId)
            if not actorPermission:
                return Result.err(authorizationDenied(
                    "You do not have permission to create orders for other users"
                ))

        // 2. Execute core business logic (delegated to domain service)
        return this.orderService.createOrder(command)
```

**Notice**: No caching, no notifications, no side effects. Those are cross-cutting concerns handled via the Decorator pattern (see [Cross-Cutting Concerns](#cross-cutting-concerns)).

### Domain Service Implementation

A Domain Service contains **pure business logic**. It validates domain rules, coordinates repositories, and returns Result types:

```
// FILE: domain/services.*

interface OrderService:
    createOrder(command: CreateOrderCommand) -> OrderResult
    cancelOrder(orderId: UUID, actorId: UUID, reason: String) -> OrderResult

class OrderServiceImpl implements OrderService:
    private orderRepo: OrderRepository
    private userRepo: UserRepository
    private inventory: InventoryService
    private clock: Clock
    private idGen: IdGenerator

    createOrder(command: CreateOrderCommand) -> OrderResult:
        // Step 1: Validate user exists and is active
        userResult = this.validateUser(command.userId)
        if userResult.isErr():
            return Result.err(userResult.error)

        // Step 2: Reserve inventory
        reserveResult = this.reserveInventory(command.items)
        if reserveResult.isErr():
            return Result.err(reserveResult.error)

        // Step 3: Create order (using injected Clock and IdGenerator)
        try:
            order = this.orderRepo.create(command)
            return Result.ok(order)
        catch Exception as e:
            this.inventory.release(command.items)
            return Result.err(externalFailure("Order creation failed", cause: e))

    private validateUser(userId: UUID) -> Result<User, DomainError>:
        user = this.userRepo.getById(userId)
        if user == null:
            return Result.err(notFound("User not found"))
        if not user.isActive:
            return Result.err(validationFailed("User account is inactive"))
        return Result.ok(user)

    private reserveInventory(items: List<OrderItem>) -> Result<Void, DomainError>:
        for item in items:
            reserved = this.inventory.reserve(item.productId, item.quantity)
            if not reserved:
                return Result.err(validationFailed(
                    "Cannot reserve inventory for product"
                ))
        return Result.ok(void)
```

---

## API Layer Patterns

### Every Endpoint Passes the Authenticated Actor

**Critical security rule**: Never fetch or mutate a resource by ID alone. Always pass the authenticated user's identity (the "actor") to the Use Case. The Use Case or Domain Service must verify that the actor has permission to perform the operation.

```
// CORRECT — actor identity is always passed
endpoint GET "/orders/{orderId}":
    orderId: UUID
    authenticatedUser: AuthContext          // from auth middleware
    useCase: GetOrderUseCase               // injected

    query = GetOrderQuery(actorId: authenticatedUser.userId, orderId: orderId)
    result = useCase.execute(query)

    if result.isErr():
        return errorMapper.toHttpResponse(result.error)
    return OrderResponseDTO.fromDomain(result.unwrap())
```

```
// WRONG — IDOR vulnerability: anyone can fetch any order by guessing the UUID
endpoint GET "/orders/{orderId}":
    result = useCase.execute(orderId)      // WHO is asking? Unknown. INSECURE.
```

### Route / Controller Organization

```
// FILE: adapters/inbound/http/v1/orders.*

router = Router(prefix: "/orders", tags: ["Orders"])

endpoint POST "" (status: 201):
    requestDTO: CreateOrderRequestDTO
    authenticatedUser: AuthContext
    useCase: CreateOrderUseCase
    errorMapper: HttpErrorMapper

    command = CreateOrderCommand.fromDTO(requestDTO, actorId: authenticatedUser.userId)
    result = useCase.execute(command)

    if result.isErr():
        return errorMapper.toHttpResponse(result.error)
    return OrderResponseDTO.fromDomain(result.unwrap())

endpoint GET "/{orderId}":
    orderId: UUID
    authenticatedUser: AuthContext
    useCase: GetOrderUseCase
    errorMapper: HttpErrorMapper

    query = GetOrderQuery(actorId: authenticatedUser.userId, orderId: orderId)
    result = useCase.execute(query)

    if result.isErr():
        return errorMapper.toHttpResponse(result.error)
    return OrderResponseDTO.fromDomain(result.unwrap())
```

### Collection Endpoints Must Be Paginated

```
// CORRECT — paginated with bounded results
endpoint GET "/users/{userId}/orders?limit=20&cursor=eyJpZCI6MTIzfQ":
    userId: UUID
    limit: PositiveInteger = 20            // default, hard max of 100
    cursor: String? = null
    authenticatedUser: AuthContext
    useCase: ListUserOrdersUseCase

    query = ListUserOrdersQuery(
        actorId: authenticatedUser.userId,
        userId: userId,
        pagination: Pagination(limit: min(limit, 100), cursor: cursor)
    )
    result = useCase.execute(query)

    if result.isErr():
        return errorMapper.toHttpResponse(result.error)
    return PaginatedResponseDTO.fromDomain(result.unwrap())
```

```
// WRONG — unbounded, will return 100,000+ rows and crash the service
endpoint GET "/users/{userId}/orders":
    return useCase.getAllOrders(userId)     // NO LIMIT. WILL CRASH.
```

### Document Response Codes

Always declare what status codes an endpoint can return:

```
endpoint POST "/orders":
    responses:
        201: "Order created successfully"
        400: "Invalid request data"
        403: "Not authorized to create this order"
        404: "User not found"
        409: "Order already exists"
```

### API Versioning

Use URL-based versioning:

```
app.includeRouter(v1OrdersRouter, prefix: "/api/v1")
app.includeRouter(v1UsersRouter,  prefix: "/api/v1")
app.includeRouter(v2OrdersRouter, prefix: "/api/v2")
```

### Streaming Responses

For large data exports, use streaming to avoid loading everything into memory:

```
endpoint GET "/orders/export":
    authenticatedUser: AuthContext
    useCase: ExportOrdersUseCase

    return StreamingResponse(
        generator: useCase.streamOrders(actorId: authenticatedUser.userId),
        mediaType: "text/csv",
        headers: {"Content-Disposition": "attachment; filename=orders.csv"}
    )
```

---

## Cross-Cutting Concerns

### The Problem

Caching, logging, metrics, notifications, and idempotency checks are cross-cutting concerns. Placing them directly inside Use Cases violates the Single Responsibility Principle and makes them impossible to toggle independently.

### The Solution: Decorator Pattern

Wrap the base Use Case with decorators. Each decorator adds exactly one concern. The DI container composes them.

```
           ┌─────────────────────────────────────────────────────────┐
           │           <<interface>>                                  │
           │         CreateOrderUseCase                               │
           │  + execute(command) -> OrderResult                      │
           └──────────────────────┬──────────────────────────────────┘
                                  │ implements
           ┌──────────────────────┼──────────────────────────────────┐
           │                      │                                  │
           ▼                      ▼                                  ▼
┌─────────────────────┐ ┌────────────────────────┐ ┌──────────────────────────┐
│ CreateOrderUseCase  │ │ CachedCreateOrder      │ │ EventPublishingCreate    │
│ Impl                │ │ UseCase                │ │ OrderUseCase             │
│                     │ │                        │ │                          │
│ Pure business logic │ │ - inner: UseCase ──────┤ │ - inner: UseCase ────────│
│ No side effects     │ │ - cache: CacheClient   │ │ - eventBus: EventBus    │
│                     │ │                        │ │                          │
│ execute(cmd):       │ │ execute(cmd):          │ │ execute(cmd):            │
│   validate(...)     │ │   check cache          │ │   result = inner(cmd)    │
│   createOrder(...)  │ │   result = inner(cmd)  │ │   if ok: publish event   │
│   return result     │ │   store in cache       │ │   return result          │
│                     │ │   return result        │ │                          │
└─────────────────────┘ └────────────────────────┘ └──────────────────────────┘

DI wiring (composition root):
  base       = CreateOrderUseCaseImpl(orderService)
  cached     = CachedCreateOrderUseCase(inner: base, cache)
  withEvents = EventPublishingCreateOrderUseCase(inner: cached, eventBus)
  register(CreateOrderUseCase -> withEvents)

Call chain:  Controller → withEvents → cached → base
```

### Implementation

```
// Base Use Case — pure business logic only
class CreateOrderUseCaseImpl implements CreateOrderUseCase:
    execute(command: CreateOrderCommand) -> OrderResult:
        // Only business logic. No caching. No notifications.
        return this.orderService.createOrder(command)

// Decorator: Idempotency / Caching
class CachedCreateOrderUseCase implements CreateOrderUseCase:
    private inner: CreateOrderUseCase      // wraps the real one
    private cache: CacheClient

    execute(command: CreateOrderCommand) -> OrderResult:
        cacheKey = "order_request:" + command.idempotencyKey
        cached = this.cache.get(cacheKey)
        if cached != null:
            return Result.ok(Order.deserialize(cached))

        result = this.inner.execute(command)    // delegate to wrapped use case

        if result.isOk():
            this.cache.set(cacheKey, result.unwrap().serialize(), expireSeconds: 3600)

        return result

// Decorator: Event Publishing / Notifications
class EventPublishingCreateOrderUseCase implements CreateOrderUseCase:
    private inner: CreateOrderUseCase
    private eventBus: EventBus

    execute(command: CreateOrderCommand) -> OrderResult:
        result = this.inner.execute(command)

        if result.isOk():
            this.eventBus.publish(OrderCreatedEvent(order: result.unwrap()))

        return result
```

### DI Composition

The DI container composes the decorator chain:

```
// In the composition root / DI configuration
provides CreateOrderUseCase:
    base = CreateOrderUseCaseImpl(orderService)
    cached = CachedCreateOrderUseCase(inner: base, cache: cacheClient)
    withEvents = EventPublishingCreateOrderUseCase(inner: cached, eventBus: eventBus)
    return withEvents
```

### Benefits

- Toggle caching by removing one decorator — zero changes to business logic
- Disable notifications in tests by not adding the event decorator
- Add metrics by writing a new `MetricsCreateOrderUseCase` decorator
- Each class has exactly one reason to change

---

## Asynchronous Programming Patterns

### Concurrent Operations

When multiple independent operations can run simultaneously, execute them concurrently:

```
// Pseudocode
function processOrderItems(items: List<OrderItem>) -> List<ProcessedItem>:
    tasks = items.map(item => async processItem(item))
    return awaitAll(tasks)
```

### Structured Concurrency with Error Handling

```
// Pseudocode
try:
    results = concurrentGroup:
        for item in items:
            launch processItem(item)
catch ValidationErrors as errors:
    for error in errors:
        log.error("Item validation failed", {itemId: error.itemId, reason: error.message})
    raise validationFailed("One or more items failed validation")
catch UnexpectedErrors as errors:
    log.error("Processing failed", {errorCount: errors.length})
    raise externalFailure("Processing failed")
```

### Resource Management

Ensure resources are always cleaned up, regardless of success or failure:

| Language | Idiom |
|----------|-------|
| Swift | `defer { }`, structured concurrency with `withTaskGroup` |
| Go | `defer`, `context.Context` |
| TypeScript | `try/finally`, `using` (TC39 Explicit Resource Management) |
| Kotlin | `use { }`, structured concurrency with `coroutineScope` |
| C# | `using`, `await using`, `IAsyncDisposable` |
| Python | `async with`, `contextlib.asynccontextmanager` |
| Rust | RAII (Drop trait), `?` operator |
| Java | `try-with-resources` |

### Fire-and-Forget Tasks

For non-critical side effects, launch them without blocking the main flow. **Always** wrap in error handling to prevent silent crashes:

```
// Pseudocode
runInBackground(name: "notify_order_" + order.id):
    try:
        this.notificationService.send(order)
    catch Exception as e:
        log.error("Notification failed", {orderId: order.id, errorType: e.type})
        // Log but never propagate — this is a background task
```

**Prefer the Decorator/Event pattern** (see [Cross-Cutting Concerns](#cross-cutting-concerns)) over inline fire-and-forget. Decorators are testable; inline background tasks are not.

---

## Security Principles

### Authorization on Every Operation

**Every** use case must receive the actor's identity and verify authorization before performing any action:

```
// Pseudocode
class GetOrderUseCaseImpl implements GetOrderUseCase:
    execute(query: GetOrderQuery) -> OrderResult:
        order = this.orderRepo.getById(query.orderId)
        if order == null:
            return Result.err(notFound("Order not found"))

        // AUTHORIZATION CHECK: does the actor own this resource?
        if order.userId != query.actorId:
            isAdmin = this.userRepo.hasAdminRole(query.actorId)
            if not isAdmin:
                return Result.err(authorizationDenied("Access denied"))

        return Result.ok(order)
```

### IDOR Prevention

Never trust client-supplied IDs without verifying ownership:

- Always pass `actorId` alongside the resource ID
- The Use Case or Domain Service verifies the actor's relationship to the resource
- Return `NOT_FOUND` (not `FORBIDDEN`) when a resource exists but the actor has no access — this prevents enumeration attacks

### Input Validation at Boundaries

- Validate all input at the system boundary (Presentation layer)
- Trust validated domain objects internally
- Never trust raw data from external sources (HTTP requests, message queues, file uploads)

### Secret Management

- Never hardcode secrets, API keys, or credentials in source code
- Load secrets from environment variables or a secret manager
- Never log secrets (see [Logging and Observability](#logging-and-observability))

---

## Type System Guidelines

### Always Use Type Annotations

Every function signature, variable with non-obvious type, and return value must be explicitly typed:

```
// CORRECT: full type annotations
function createOrder(
    command: CreateOrderCommand,
    userId: UUID,
    notify: Boolean = true
) -> OrderResult

// INCORRECT: missing type information
function createOrder(command, userId, notify = true)
```

### Use the Language's Preferred Nullable/Optional Syntax

| Language | Nullable Syntax | Preferred |
|----------|----------------|-----------|
| Swift | `User?` | Native optional |
| Go | `*User` or `(User, error)` | Pointer or multi-return |
| TypeScript | `User \| null` | Union type |
| Kotlin | `User?` | Native nullable |
| C# | `User?` | Nullable reference type |
| Python | `User \| None` | Modern union syntax (3.10+) |
| Rust | `Option<User>` | Native enum |
| Java | `Optional<User>` | `Optional` for return types |

### Use Generics Where Appropriate

```
// Pseudocode — generic repository port
interface Repository<T>:
    getById(id: UUID) -> T?
    create(entity: T) -> T
    update(id: UUID, entity: T) -> T
    delete(id: UUID) -> Boolean
```

---

## Naming Conventions

### Follow the Language's Idiomatic Style

| Aspect | Swift | Go | TypeScript | Kotlin | C# | Python | Rust |
|--------|-------|-----|-----------|--------|-----|--------|------|
| Files | PascalCase | snake_case | camelCase/kebab | PascalCase | PascalCase | snake_case | snake_case |
| Classes/Structs | PascalCase | PascalCase | PascalCase | PascalCase | PascalCase | PascalCase | PascalCase |
| Functions | camelCase | PascalCase (exported) | camelCase | camelCase | PascalCase | snake_case | snake_case |
| Variables | camelCase | camelCase | camelCase | camelCase | camelCase | snake_case | snake_case |
| Constants | camelCase | PascalCase | UPPER_SNAKE | UPPER_SNAKE | PascalCase | UPPER_SNAKE | UPPER_SNAKE |

### Interface/Protocol Naming by Language

| Language | Convention | Example |
|----------|-----------|---------|
| Swift | Capability suffix (`-able`, `-ing`) or noun | `Equatable`, `UserRepository` |
| Go | `-er` suffix for single-method; descriptive noun otherwise | `Reader`, `OrderService` |
| TypeScript | PascalCase, no prefix (modern) | `UserRepository` |
| Kotlin | PascalCase, no prefix | `UserRepository` |
| C# | `I`-prefix | `IUserRepository` |
| Python | `Protocol` suffix | `UserRepositoryProtocol` |
| Java | PascalCase, no prefix (modern) | `UserRepository` |
| Rust | Descriptive noun or verb | `Display`, `Serialize` |

### Universal Semantic Patterns

Regardless of language, follow these semantic naming rules:

**Type Names:**

| Type | Pattern | Example |
|------|---------|---------|
| Port Interface | `{Name}` + language convention | `OrderService`, `IOrderService` |
| Adapter Implementation | `{Qualifier}{Name}` | `PostgresUserRepository`, `EmailNotificationGateway` |
| Request DTO | `{Action}{Resource}RequestDTO` | `CreateOrderRequestDTO` |
| Domain Command | `{Action}{Resource}Command` | `CreateOrderCommand` |
| Domain Query | `{Action}{Resource}Query` | `GetOrderQuery`, `ListUserOrdersQuery` |
| Response DTO | `{Resource}ResponseDTO` | `OrderResponseDTO` |
| Domain Error | `DomainError` with `ErrorCode` | `DomainError(code: NOT_FOUND)` |
| Value Object | Domain noun | `EmailAddress`, `PositiveDecimal`, `Address` |
| Use Case | `{Action}{Resource}UseCase` | `CreateOrderUseCase` |

**Method Names:**

```
// Data access — describe the query
getById(id) -> Entity?
create(command) -> Entity
update(id, command) -> Entity
delete(id) -> Boolean
findByCriteria(criteria, pagination) -> PaginatedResult<Entity>

// Private/internal — use language convention for visibility
_validateRequest(command) -> ValidationResult    // Python
private func validateRequest(...)               // Swift
func validateRequest(...)                       // Go (unexported = lowercase)

// Boolean methods — use is, has, can prefixes
isValid() -> Boolean
hasPermission(action) -> Boolean
canCancel() -> Boolean
```

---

## Code Organization

### Import / Dependency Order

Always order imports consistently:

```
// 1. Standard library / language built-ins
// 2. Third-party packages / external dependencies
// 3. Local / project imports (ordered by layer: domain → application → adapters)
```

### Module Structure

```
// Standard module layout:

// Module-level documentation (brief)
// Imports (ordered as above)
// Constants
// Interfaces / Protocols (ports)
// Implementations (adapters or domain services)
// Helper functions (private, if needed)
```

### Class Structure

```
class OrderServiceImpl:
    // 1. Class-level constants
    MAX_RETRIES = 3

    // 2. Constructor (all dependencies injected — including Clock, IdGenerator)
    constructor(orderRepo, userRepo, clock, idGen):
        this._orderRepo = orderRepo
        this._userRepo = userRepo
        this._clock = clock
        this._idGen = idGen

    // 3. Public methods
    createOrder(command) -> OrderResult:
        ...

    cancelOrder(orderId, actorId, reason) -> OrderResult:
        ...

    // 4. Private methods
    _validateUser(userId) -> UserResult:
        ...
```

---

## Testing Patterns

### Test Organization

```
tests/
├── shared_fixtures.*           # Shared test fixtures and helpers
├── fakes/                      # Fake implementations of port interfaces
│   ├── fake_order_repository.*
│   ├── fake_user_repository.*
│   ├── fake_clock.*
│   └── fake_id_generator.*
├── factories.*                 # Test data factories
├── unit/
│   ├── domain/
│   │   ├── test_order_service.*
│   │   └── test_value_objects.*
│   ├── application/
│   │   └── test_create_order_use_case.*
│   └── adapters/
│       └── test_error_mapper.*
└── integration/
    ├── test_orders_api.*
    └── test_database.*
```

### Fake Implementations

Create in-memory fakes that implement the same port interfaces as production code.

**Critical rule**: Each test must get its own fresh fake instance. Never share mutable fake state across tests — this causes race conditions in parallel test execution and state bleed between tests.

```
// Pseudocode
class FakeOrderRepository implements OrderRepository:
    private orders: Map<UUID, Order> = {}

    getById(orderId: UUID) -> Order?:
        return this.orders.get(orderId)

    getByUser(userId: UUID, pagination: Pagination) -> PaginatedResult<Order>:
        filtered = this.orders.values().filter(o => o.userId == userId)
        page = filtered.skip(pagination.offset).take(pagination.limit)
        return PaginatedResult(
            items: page,
            hasMore: filtered.length > pagination.offset + pagination.limit
        )

    create(command: CreateOrderCommand) -> Order:
        order = Order(
            id: command.id,                    // ID was generated via injected IdGenerator
            userId: command.userId,
            status: OrderStatus.PENDING,
            items: command.items,
            createdAt: command.createdAt        // timestamp via injected Clock
        )
        this.orders.set(order.id, order)
        return order

    // Test helpers (not part of the port interface)
    seedTestData(order: Order):
        this.orders.set(order.id, order)
```

### Test Fixtures — Fresh Instance Per Test

```
// Pseudocode — each test gets a NEW fake instance

class TestOrderService:
    // Before each test: create fresh fakes
    setup():
        this.clock = NEW FakeClock(fixedTime: DateTime(2025, 1, 15, 12, 0, 0))
        this.idGen = NEW FakeIdGenerator(nextId: knownUUID)
        this.orderRepo = NEW FakeOrderRepository()
        this.userRepo = NEW FakeUserRepository()
        this.service = OrderServiceImpl(
            this.orderRepo, this.userRepo, this.clock, this.idGen
        )

        // Seed test data into the fresh fakes
        this.testUser = User(id: uuid(), email: "test@example.com", isActive: true)
        this.userRepo.seedTestData(this.testUser)
```

### Test Fixtures with DI Override

Replace real implementations with fakes in the test DI container:

```
FakeProvider:
    provides OrderRepository:   return NEW FakeOrderRepository()
    provides Clock:             return NEW FakeClock(fixedTime: ...)
    provides IdGenerator:       return NEW FakeIdGenerator(nextId: ...)

testContainer = createContainer(
    SettingsProvider(),
    FakeProvider(),              // overrides real infrastructure
    ApplicationProviders()
)
```

### Unit Test Structure

Follow the **Arrange - Act - Assert** pattern:

```
class TestCreateOrderUseCase:
    setup():
        this.clock = NEW FakeClock(fixedTime: DateTime(2025, 1, 15, 12, 0, 0))
        this.idGen = NEW FakeIdGenerator(nextId: knownOrderId)
        this.orderRepo = NEW FakeOrderRepository()
        this.userRepo = NEW FakeUserRepository()
        this.orderService = OrderServiceImpl(
            this.orderRepo, this.userRepo, this.clock, this.idGen
        )
        this.useCase = CreateOrderUseCaseImpl(this.orderService, this.userRepo)
        this.testUser = User(id: testUserId, email: "test@example.com", isActive: true)
        this.userRepo.seedTestData(this.testUser)

    test "create order succeeds for authorized user":
        // Arrange
        command = CreateOrderCommand(
            actorId: this.testUser.id,
            userId: this.testUser.id,
            items: [OrderItem(productId: uuid(), quantity: 1, price: PositiveDecimal(10.00))]
        )

        // Act
        result = this.useCase.execute(command)

        // Assert
        assert result.isOk()
        order = result.unwrap()
        assert order.id == knownOrderId                      // deterministic via FakeIdGenerator
        assert order.userId == this.testUser.id
        assert order.status == OrderStatus.PENDING
        assert order.createdAt == DateTime(2025, 1, 15, 12, 0, 0)  // deterministic via FakeClock

    test "create order fails for non-existent user":
        // Arrange
        command = CreateOrderCommand(
            actorId: randomUUID(),
            userId: randomUUID(),
            items: [OrderItem(productId: uuid(), quantity: 1, price: PositiveDecimal(10.00))]
        )

        // Act
        result = this.useCase.execute(command)

        // Assert
        assert result.isErr()
        assert result.error.code == ErrorCode.NOT_FOUND

    test "create order denied when actor is not the user and not admin":
        // Arrange
        otherUser = User(id: uuid(), email: "other@example.com", isActive: true)
        this.userRepo.seedTestData(otherUser)

        command = CreateOrderCommand(
            actorId: otherUser.id,           // different from userId
            userId: this.testUser.id,
            items: [OrderItem(productId: uuid(), quantity: 1, price: PositiveDecimal(10.00))]
        )

        // Act
        result = this.useCase.execute(command)

        // Assert
        assert result.isErr()
        assert result.error.code == ErrorCode.AUTHORIZATION_DENIED

    test "value object rejects invalid email":
        // Act & Assert
        assertThrows DomainError:
            EmailAddress("not-an-email")

    test "value object rejects non-positive amount":
        // Act & Assert
        assertThrows DomainError:
            PositiveDecimal(-5.00)
```

### Testing Principles

1. **Test behavior, not implementation**: Assert on outcomes, not internal method calls
2. **Use fakes over mocks**: In-memory implementations are more maintainable than mock frameworks
3. **One assertion concept per test**: Each test verifies one logical outcome
4. **Test both happy path and error cases**: Every `Result.ok()` path must have a corresponding `Result.err()` test
5. **Test authorization separately**: Verify that unauthorized actors are rejected
6. **Test Value Object invariants**: Verify that invalid values are rejected at construction
7. **Keep tests fast**: Unit tests run in milliseconds; use fakes to avoid I/O
8. **Isolate test state**: Each test gets fresh fakes — no shared mutable state
9. **Deterministic tests**: Use FakeClock and FakeIdGenerator so tests produce identical results every run
10. **Name tests descriptively**: Test names describe the scenario and expected outcome

---

## Logging and Observability

### Safe Logging Rules

**Critical rule**: Never log raw request payloads, DTOs, complete error stack traces, or unsanitized exception messages. Logs are often stored in plain text and accessed by many people. Leaking PII, credentials, or database internals is a security incident.

### What to Log

```
// CORRECT: structured, sanitized log entries with only safe identifiers
log.info("Order created", {orderId: order.id, userId: order.userId, itemCount: 3})
log.error("Payment failed", {orderId: order.id, errorType: "timeout", provider: "stripe"})
log.warn("Inventory low", {productId: item.productId, remaining: 2})
```

### What NEVER to Log

```
// WRONG: logging raw request body — may contain PII, passwords, tokens
log.info("Request received", {body: rawRequestBody})          // NEVER

// WRONG: logging full exception — may expose DB schema, query internals
log.error("Error: " + exception.toString())                   // NEVER

// WRONG: logging user data
log.info("User created", {email: user.email, phone: user.phone})  // NEVER log PII

// WRONG: logging credentials or connection details
log.debug("Connecting", {connectionString: dbUrl})             // NEVER log secrets
```

### Logging Principles

1. **Log events, not data**: Log what happened (verb + noun + ID), not the full payload
2. **Use structured logging**: Key-value pairs, not string concatenation
3. **Sanitize by default**: Only log entity IDs, counts, error types, and status codes
4. **Separate log levels intentionally**:
   - `ERROR`: something failed and requires attention
   - `WARN`: something unexpected but handled
   - `INFO`: significant business events (order created, payment processed)
   - `DEBUG`: diagnostic detail (only in development, never in production by default)
5. **Never log secrets**: API keys, tokens, passwords, connection strings, certificates
6. **Never log PII**: emails, phone numbers, addresses, IP addresses, names — unless you have explicit legal/compliance authorization and a redaction pipeline

---

## Quick Reference

### New Feature Checklist

1. [ ] Define domain entities and value objects (self-validating, immutable)
2. [ ] Define port interface in the Application layer
3. [ ] Create domain command / query objects (include `actorId`)
4. [ ] Implement Domain Service (business logic, returns Result types, uses injected Clock/IdGenerator)
5. [ ] Implement Use Case (orchestration, authorization check)
6. [ ] Implement Repository adapter (Infrastructure, with pagination for collections)
7. [ ] Create Request/Response DTOs (Presentation layer only)
8. [ ] Create DTO ↔ Domain mappers in the Controller
9. [ ] Create Route/Controller endpoint (always passes actor identity)
10. [ ] Add error mapping for new error codes in the ErrorMapper (if any)
11. [ ] Register all components in DI container
12. [ ] Add Decorators for cross-cutting concerns (caching, events) if needed
13. [ ] Write unit tests (happy path + error cases + authorization + value object invariants)
14. [ ] Write integration tests

### Code Review Checklist

- [ ] Port interfaces defined in the Application layer, implementations in outer layers
- [ ] All dependency arrows point inward (Domain ← Application ← Adapters ← Infrastructure)
- [ ] Type annotations on all function signatures
- [ ] Result type (or structured domain errors) for error handling — no HTTP in domain
- [ ] DTOs exist only in the Presentation layer; domain commands used internally
- [ ] Error mapping happens exclusively in the Presentation layer (ErrorMapper)
- [ ] Every endpoint passes authenticated actor identity to the Use Case
- [ ] Use Case verifies authorization before performing operations
- [ ] Dependencies injected, never created internally (including Clock and IdGenerator)
- [ ] No direct calls to `now()`, `Date()`, `UUID.random()` in Domain or Application layers
- [ ] Cross-cutting concerns (caching, notifications) handled via Decorators, not inline
- [ ] All collection queries and endpoints use pagination with hard limits
- [ ] Value Objects validate their invariants on construction and are immutable
- [ ] No business logic in routes/controllers
- [ ] Proper resource cleanup (connections, files, transactions via UnitOfWork)
- [ ] Logs contain only sanitized data — no PII, secrets, or raw payloads
- [ ] Tests for success, failure, authorization denial, and value object rejection paths
- [ ] Each test has its own fresh fake instances — no shared mutable state
- [ ] Tests are deterministic via FakeClock and FakeIdGenerator
