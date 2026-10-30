'use strict';
// 角色权限矩阵，对应需求文档第 2 节
//
// 权限说明：
//   dashboard:view     查看盯盘大屏
//   monitor:view       查看全部监控数据
//   monitor:room       查看房态、订单（前台值班）
//   monitor:review     查看评价（客服）
//   alert:handle       处理全部告警
//   alert:handle:type  按类型处理告警（order/review）
//   suggest:confirm    确认上架/调价（无限额）
//   suggest:confirm:limited  确认上架/调价（受限额约束，如单次调价 ≤ ±15%）
//   suggest:create     直接发起调价/上下架申请
//   rule:edit          修改阈值
//   rule:edit:guardrail 修改底价/封顶价（仅管理者）
//   user:manage        账户与权限管理
//   delegate:manage    设置代理审批人
//   audit:view         查看审计日志
//   report:view        看板与报表

const ROLE_MATRIX = {
  manager: [                          // 管理者：全部权限，无限额
    'dashboard:view', 'monitor:view',
    'alert:handle',
    'suggest:confirm', 'suggest:create',
    'rule:edit', 'rule:edit:guardrail',
    'user:manage', 'delegate:manage',
    'audit:view', 'report:view',
  ],
  revenue: [                          // 收益经理：确认受限额约束
    'dashboard:view', 'monitor:view',
    'alert:handle',
    'suggest:confirm:limited', 'suggest:create',
    'rule:edit',
    'audit:view', 'report:view',
  ],
  frontdesk: [                        // 前台值班：只看房态订单，处理订单类告警
    'dashboard:view', 'monitor:room',
    'alert:handle:order', 'suggest:create',
  ],
  service: [                          // 客服/点评专员：只看评价，处理评价类
    'dashboard:view', 'monitor:review',
    'alert:handle:review',
  ],
  viewer: [                           // 只读/老板：看板与报表
    'dashboard:view', 'report:view',
  ],
};

const ROLE_NAMES = {
  manager: '管理者', revenue: '收益经理', frontdesk: '前台值班', service: '客服/点评专员', viewer: '只读/老板',
};

/** 角色的数据范围：全部门店/渠道，或仅限授权的 */
function scopeOf(role) {
  return (role === 'manager' || role === 'revenue' || role === 'viewer') ? 'all' : 'granted';
}

/** 收益经理单次调价限额（±15%，见需求文档第2节），返回小数 0.15 */
function priceChangeLimit() {
  return 0.15;
}

module.exports = { ROLE_MATRIX, ROLE_NAMES, scopeOf, priceChangeLimit };
