from subscribe_flow.contracts import ChannelDescriptor, OperationCapability


def descriptor():
    deps = ("opencli-1.8.8", "node", "external-browser-bridge")
    return ChannelDescriptor("bilibili", "哔哩哔哩", "opencli", {
        "resolve_source": OperationCapability(True, True, "not_required", notes="只解析 UID/主页，不等于确认存在"),
        "search_sources": OperationCapability(True, True, dependencies=deps, notes="候选按稳定 UID 区分；认证要求未确认"),
        "list_items": OperationCapability(True, True, dependencies=deps, pagination="page_number",
                                           ordering="pubdate_requested_not_guaranteed", full_history=False,
                                           notes="工具丢弃总数/末页证据，分页读取不等于全历史完成；空数组不算成功"),
        "get_item_detail": OperationCapability(True, True, dependencies=deps, notes="可选补充；失败不影响列表"),
    })
