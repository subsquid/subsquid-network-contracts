import { Context } from './context';
import { v4 as uuidv4 } from 'uuid';

export class TaskContext extends Context {
  constructor(name: string) {
    super({ task_name: name, task_id: `task-${uuidv4()}` });
  }
} 