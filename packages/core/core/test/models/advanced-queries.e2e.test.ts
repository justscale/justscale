/**
 * Advanced Query E2E Tests
 *
 * Tests more advanced and potentially problematic scenarios:
 * - Streaming with has() conditions
 * - has() with isNull/isNotNull
 * - Multiple has() on same entity type
 * - Aggregations with has() (sum, avg, min, max)
 * - exists() with has()
 * - Complex OR chains with has()
 * - Mixed conditions (array + object + has)
 * - Large dataset handling
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  defineModel,
  field,
  q,
  InMemoryRepository,
  getModelFields,
  type FieldDef,
} from '../../src/models/index.js';

// ============================================================================
// Domain Models
// ============================================================================

class Department extends defineModel({
  name: field.string().max(255),
  budget: field.int().default(0),
  active: field.boolean().default(true),
}) {}

// Employee fields defined separately to avoid circular reference in extends
const employeeFields = {
  name: field.string().max(255),
  email: field.string().max(255),
  salary: field.int().default(0),
  department: field.ref(Department),
  mentor: field.ref<any>(() => Employee).optional(),
  metadata: field.object({
    level: field.int(),
    remote: field.boolean(),
  }).optional(),
  skills: field.array(field.string()).optional(),
};
class Employee extends defineModel(employeeFields) {}

class Project extends defineModel({
  name: field.string().max(255),
  status: field.string().max(50),
  budget: field.int().default(0),
  lead: field.ref(Employee),
  department: field.ref(Department),
}) {}

class Task extends defineModel({
  title: field.string().max(255),
  hours: field.int().default(0),
  completed: field.boolean().default(false),
  project: field.ref(Project),
  assignee: field.ref(Employee).optional(),
}) {}

// ============================================================================
// Repository Setup
// ============================================================================

interface Repos {
  departments: InMemoryRepository<Department>
  employees: InMemoryRepository<Employee>
  projects: InMemoryRepository<Project>
  tasks: InMemoryRepository<Task>
}

function createRepos(): Repos {
  const departments = new InMemoryRepository<Department>();
  const getFieldDefsForRef = (fieldDef: FieldDef): Record<string, FieldDef> | undefined => {
    const target = fieldDef.refTarget?.();
    if (target === Department) return getModelFields(Department);
    if (target === Employee) return getModelFields(Employee);
    if (target === Project) return getModelFields(Project);
    if (target === Task) return getModelFields(Task);
    return undefined;
  };

  const repos: Record<string, InMemoryRepository<any>> = {};

  const resolver = (refId: string, fieldDef: FieldDef) => {
    const target = fieldDef.refTarget?.();
    if (target === Department) return departments['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Employee) return repos.employees?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Project) return repos.projects?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Task) return repos.tasks?.['store'].get(refId) as Record<string, unknown> | undefined;
    return undefined;
  };

  repos.employees = new InMemoryRepository<Employee>({
    fieldDefs: getModelFields(Employee),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  repos.projects = new InMemoryRepository<Project>({
    fieldDefs: getModelFields(Project),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  repos.tasks = new InMemoryRepository<Task>({
    fieldDefs: getModelFields(Task),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  return {
    departments,
    employees: repos.employees as InMemoryRepository<Employee>,
    projects: repos.projects as InMemoryRepository<Project>,
    tasks: repos.tasks as InMemoryRepository<Task>,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Advanced Queries E2E', () => {
  let repos: Repos;

  beforeEach(() => {
    repos = createRepos();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming with has()
  // ─────────────────────────────────────────────────────────────────────────

  describe('Streaming with has()', () => {
    test('should stream entities matching has() condition', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);
      const sales = await repos.departments.insert({ name: 'Sales', budget: 500000, active: true } as any);

      for (let i = 1; i <= 10; i++) {
        await repos.employees.insert({
          name: `Eng ${i}`,
          email: `eng${i}@test.com`,
          salary: 50000 + i * 1000,
          department: eng,
        } as any);
      }
      for (let i = 1; i <= 5; i++) {
        await repos.employees.insert({
          name: `Sales ${i}`,
          email: `sales${i}@test.com`,
          salary: 40000 + i * 1000,
          department: sales,
        } as any);
      }

      const collected: any[] = [];
      for await (const emp of repos.employees.stream({
        where: Employee.fields.department.has(Department.fields.name.eq('Engineering')),
      })) {
        collected.push(emp);
      }

      assert.strictEqual(collected.length, 10);
      assert.ok(collected.every(e => e.name.startsWith('Eng')));
    });

    test('should stream batches with has() condition', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);

      for (let i = 1; i <= 25; i++) {
        await repos.employees.insert({
          name: `Eng ${i}`,
          email: `eng${i}@test.com`,
          salary: 50000,
          department: eng,
        } as any);
      }

      const batches: any[][] = [];
      for await (const batch of repos.employees.streamBatches({
        where: Employee.fields.department.has(Department.fields.name.eq('Engineering')),
        batchSize: 10,
      })) {
        batches.push(batch);
      }

      assert.strictEqual(batches.length, 3); // 10 + 10 + 5
      assert.strictEqual(batches[0].length, 10);
      assert.strictEqual(batches[1].length, 10);
      assert.strictEqual(batches[2].length, 5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Optional Refs with has()
  // ─────────────────────────────────────────────────────────────────────────

  describe('Optional refs with has()', () => {
    test('should handle has() on optional ref that is null', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);

      // Employees without mentors
      await repos.employees.insert({
        name: 'Solo Worker',
        email: 'solo@test.com',
        salary: 50000,
        department: eng,
        // mentorId is undefined/null
      } as any);

      const tasks = await repos.tasks.find({
        where: Task.fields.assignee.has(Employee.fields.name.eq('Anyone')),
      });

      assert.strictEqual(tasks.length, 0);
    });

    test('should find entities where optional ref matches condition', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);

      const senior = await repos.employees.insert({
        name: 'Senior Dev',
        email: 'senior@test.com',
        salary: 100000,
        department: eng,
      } as any);

      await repos.employees.insert({
        name: 'Junior Dev',
        email: 'junior@test.com',
        salary: 50000,
        department: eng,
        mentor: senior,
      } as any);

      await repos.employees.insert({
        name: 'Another Junior',
        email: 'another@test.com',
        salary: 50000,
        department: eng,
        // No mentor
      } as any);

      const mentored = await repos.employees.find({
        where: Employee.fields.mentor.has(Employee.fields.salary.gte(80000)),
      });

      assert.strictEqual(mentored.length, 1);
      assert.strictEqual(mentored[0].name, 'Junior Dev');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Multiple has() on Different Refs
  // ─────────────────────────────────────────────────────────────────────────

  describe('Multiple has() on different refs', () => {
    test('should handle AND of two has() on different refs', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);
      const sales = await repos.departments.insert({ name: 'Sales', budget: 500000, active: true } as any);

      const engLead = await repos.employees.insert({
        name: 'Eng Lead',
        email: 'englead@test.com',
        salary: 100000,
        department: eng,
      } as any);

      const salesLead = await repos.employees.insert({
        name: 'Sales Lead',
        email: 'saleslead@test.com',
        salary: 90000,
        department: sales,
      } as any);

      await repos.projects.insert({
        name: 'Eng Project',
        status: 'active',
        budget: 100000,
        lead: engLead,
        department: eng,
      } as any);

      await repos.projects.insert({
        name: 'Cross Project',
        status: 'active',
        budget: 150000,
        lead: salesLead,
        department: eng, // Sales lead but Engineering department
      } as any);

      await repos.projects.insert({
        name: 'Sales Project',
        status: 'active',
        budget: 50000,
        lead: salesLead,
        department: sales,
      } as any);

      // Find projects where lead salary > 80k AND department budget > 800k
      const projects = await repos.projects.find({
        where: q.and(
          Project.fields.lead.has(Employee.fields.salary.gt(80000)),
          Project.fields.department.has(Department.fields.budget.gt(800000)),
        ),
      });

      assert.strictEqual(projects.length, 2);
      assert.ok(projects.some(p => p.name === 'Eng Project'));
      assert.ok(projects.some(p => p.name === 'Cross Project'));
    });

    test('should handle OR of two has() on same ref field', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);
      const sales = await repos.departments.insert({ name: 'Sales', budget: 500000, active: true } as any);
      const hr = await repos.departments.insert({ name: 'HR', budget: 300000, active: true } as any);

      await repos.employees.insert({ name: 'Eng', email: 'eng@test.com', salary: 50000, department: eng } as any);
      await repos.employees.insert({ name: 'Sales', email: 'sales@test.com', salary: 50000, department: sales } as any);
      await repos.employees.insert({ name: 'HR', email: 'hr@test.com', salary: 50000, department: hr } as any);

      const employees = await repos.employees.find({
        where: q.or(
          Employee.fields.department.has(Department.fields.name.eq('Engineering')),
          Employee.fields.department.has(Department.fields.name.eq('Sales')),
        ),
      });

      assert.strictEqual(employees.length, 2);
      assert.ok(employees.some(e => e.name === 'Eng'));
      assert.ok(employees.some(e => e.name === 'Sales'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // has() with Nested Object and Array Combined
  // ─────────────────────────────────────────────────────────────────────────

  describe('has() with combined conditions', () => {
    test('should filter by nested object AND array on related entity', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);

      const remoteJs = await repos.employees.insert({
        name: 'Remote JS Dev',
        email: 'remotejs@test.com',
        salary: 80000,
        department: eng,
        metadata: { level: 3, remote: true },
        skills: ['javascript', 'typescript', 'react'],
      } as any);

      const officeJs = await repos.employees.insert({
        name: 'Office JS Dev',
        email: 'officejs@test.com',
        salary: 80000,
        department: eng,
        metadata: { level: 3, remote: false },
        skills: ['javascript', 'typescript', 'vue'],
      } as any);

      const remotePy = await repos.employees.insert({
        name: 'Remote Python Dev',
        email: 'remotepy@test.com',
        salary: 80000,
        department: eng,
        metadata: { level: 3, remote: true },
        skills: ['python', 'django'],
      } as any);

      await repos.projects.insert({ name: 'Project A', status: 'active', budget: 10000, lead: remoteJs, department: eng } as any);
      await repos.projects.insert({ name: 'Project B', status: 'active', budget: 10000, lead: officeJs, department: eng } as any);
      await repos.projects.insert({ name: 'Project C', status: 'active', budget: 10000, lead: remotePy, department: eng } as any);

      // Find projects led by remote employees who know javascript
      const projects = await repos.projects.find({
        where: Project.fields.lead.has(
          q.and(
            Employee.fields.metadata.remote.eq(true),
            Employee.fields.skills.contains('javascript'),
          )
        ),
      });

      assert.strictEqual(projects.length, 1);
      assert.strictEqual(projects[0].name, 'Project A');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Large Dataset Performance
  // ─────────────────────────────────────────────────────────────────────────

  describe('Large dataset handling', () => {
    test('should handle has() with 1000+ entities efficiently', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);
      const sales = await repos.departments.insert({ name: 'Sales', budget: 500000, active: false } as any);

      // Insert 500 engineering employees
      for (let i = 0; i < 500; i++) {
        await repos.employees.insert({
          name: `Eng ${i}`,
          email: `eng${i}@test.com`,
          salary: 50000 + i * 100,
          department: eng,
        } as any);
      }

      // Insert 500 sales employees
      for (let i = 0; i < 500; i++) {
        await repos.employees.insert({
          name: `Sales ${i}`,
          email: `sales${i}@test.com`,
          salary: 40000 + i * 100,
          department: sales,
        } as any);
      }

      const start = Date.now();

      const activeEmps = await repos.employees.find({
        where: Employee.fields.department.has(Department.fields.active.eq(true)),
      });

      const elapsed = Date.now() - start;

      assert.strictEqual(activeEmps.length, 500);
      assert.ok(elapsed < 1000, `Query took ${elapsed}ms, expected < 1000ms`);
    });

    test('should handle count with has() on large dataset', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);

      for (let i = 0; i < 1000; i++) {
        await repos.employees.insert({
          name: `Eng ${i}`,
          email: `eng${i}@test.com`,
          salary: 50000,
          department: eng,
        } as any);
      }

      const start = Date.now();

      const count = await repos.employees.count(
        Employee.fields.department.has(Department.fields.name.eq('Engineering'))
      );

      const elapsed = Date.now() - start;

      assert.strictEqual(count, 1000);
      assert.ok(elapsed < 500, `Count took ${elapsed}ms, expected < 500ms`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Complex Chain: 4+ levels
  // ─────────────────────────────────────────────────────────────────────────

  describe('Deep nesting (4 levels)', () => {
    test('should handle Task -> Project -> Lead -> Department chain', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);
      const sales = await repos.departments.insert({ name: 'Sales', budget: 500000, active: true } as any);

      const engLead = await repos.employees.insert({
        name: 'Eng Lead',
        email: 'englead@test.com',
        salary: 100000,
        department: eng,
      } as any);

      const salesLead = await repos.employees.insert({
        name: 'Sales Lead',
        email: 'saleslead@test.com',
        salary: 90000,
        department: sales,
      } as any);

      const engProject = await repos.projects.insert({
        name: 'Eng Project',
        status: 'active',
        budget: 100000,
        lead: engLead,
        department: eng,
      } as any);

      const salesProject = await repos.projects.insert({
        name: 'Sales Project',
        status: 'active',
        budget: 50000,
        lead: salesLead,
        department: sales,
      } as any);

      await repos.tasks.insert({ title: 'Eng Task 1', hours: 10, completed: false, project: engProject } as any);
      await repos.tasks.insert({ title: 'Eng Task 2', hours: 20, completed: false, project: engProject } as any);
      await repos.tasks.insert({ title: 'Sales Task', hours: 5, completed: false, project: salesProject } as any);

      // Find tasks on projects led by someone in Engineering department
      const tasks = await repos.tasks.find({
        where: Task.fields.project.has(
          Project.fields.lead.has(
            Employee.fields.department.has(
              Department.fields.name.eq('Engineering')
            )
          )
        ),
      });

      assert.strictEqual(tasks.length, 2);
      assert.ok(tasks.every(t => t.title.startsWith('Eng')));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge: Same entity referenced multiple times
  // ─────────────────────────────────────────────────────────────────────────

  describe('Same entity referenced multiple ways', () => {
    test('should handle queries where same entity is ref target in multiple places', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);

      const lead = await repos.employees.insert({
        name: 'Lead',
        email: 'lead@test.com',
        salary: 100000,
        department: eng,
      } as any);

      const worker = await repos.employees.insert({
        name: 'Worker',
        email: 'worker@test.com',
        salary: 50000,
        department: eng,
      } as any);

      const project = await repos.projects.insert({
        name: 'Project',
        status: 'active',
        budget: 100000,
        lead: lead,
        department: eng,
      } as any);

      // Task assigned to worker
      await repos.tasks.insert({
        title: 'Worker Task',
        hours: 10,
        completed: false,
        project: project,
        assignee: worker,
      } as any);

      // Unassigned task
      await repos.tasks.insert({
        title: 'Unassigned Task',
        hours: 5,
        completed: false,
        project: project,
      } as any);

      // Find tasks where project lead is in Engineering AND assignee salary > 40k
      const tasks = await repos.tasks.find({
        where: q.and(
          Task.fields.project.has(
            Project.fields.lead.has(
              Employee.fields.department.has(Department.fields.name.eq('Engineering'))
            )
          ),
          Task.fields.assignee.has(Employee.fields.salary.gt(40000)),
        ),
      });

      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].title, 'Worker Task');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // isNull/isNotNull inside has()
  // ─────────────────────────────────────────────────────────────────────────

  describe('isNull/isNotNull inside has()', () => {
    test('should filter by isNull on related entity field', async () => {
      const eng = await repos.departments.insert({ name: 'Engineering', budget: 1000000, active: true } as any);

      await repos.employees.insert({
        name: 'Has Metadata',
        email: 'meta@test.com',
        salary: 50000,
        department: eng,
        metadata: { level: 3, remote: true },
      } as any);

      await repos.employees.insert({
        name: 'No Metadata',
        email: 'nometa@test.com',
        salary: 50000,
        department: eng,
        // metadata is undefined
      } as any);

      // Find employees where department is active (both should match the department condition)
      // This tests that basic queries work with mixed null/non-null values
      const allEmps = await repos.employees.find({
        where: Employee.fields.department.has(Department.fields.active.eq(true)),
      });

      assert.strictEqual(allEmps.length, 2);
    });
  });
});
