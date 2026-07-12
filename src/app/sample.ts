// Sample contracts (Mini §6.3) seeded into a fresh workspace.
export const STORAGE_SOL = `// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;

contract Storage {
    uint256 private value;

    function setValue(uint256 v) public {
        value = v;
    }

    function getValue() public view returns (uint256) {
        return value;
    }
}
`;

// Parameterless constructor + two methods whose parameters together exercise
// every Deploy/Execute input control (numeric, bool, address, bytes, string,
// dynamic/fixed arrays, struct, array of structs). Split in two because a
// single 13-parameter function exceeds the EVM stack ("stack too deep").
export const EXAMPLE_DETAILED_SOL = `// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;
pragma abicoder v2;

contract ExampleDetailed {
    struct Point { uint256 x; uint256 y; }

    // Scalar input controls.
    function demoScalars(
        uint256 amount,       // numeric + ETH/wei converter
        uint8 smallNumber,    // numeric (digit-filtered)
        int256 signedNumber,  // numeric (allows leading -)
        bool enabled,         // true/false select
        address account,      // 32-byte hex
        bytes32 hashValue,    // fixed-size hex
        bytes calldata blob,  // dynamic hex
        string calldata note  // free text
    ) external pure returns (uint256) {
        uint256 sum = amount + smallNumber + blob.length + bytes(note).length;
        if (enabled && signedNumber > 0) sum += uint256(signedNumber);
        if (account != address(0) && hashValue != bytes32(0)) sum += 1;
        return sum;
    }

    // Array, fixed-array, struct, and array-of-struct input controls.
    function demoArrays(
        uint256[] calldata numbers, // dynamic array (add/remove rows)
        string[] calldata words,    // dynamic array of strings
        address[2] calldata pair,   // fixed-size array
        Point calldata point,       // struct sub-form
        Point[] calldata points     // array of structs
    ) external pure returns (uint256) {
        uint256 sum = point.x + point.y + numbers.length + words.length + points.length;
        if (pair[0] != address(0)) sum += 1;
        return sum;
    }
}
`;

// A self-contained ERC20 token whose constructor takes name, symbol,
// totalSupply, and decimals — handy for exercising Deploy/Execute.
export const EXAMPLE_TOKEN_SOL = `// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

contract ExampleToken is IERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public override totalSupply;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    // totalSupply_ is expressed in whole tokens; it is scaled by 10**decimals_.
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        totalSupply = totalSupply_ * (10 ** uint256(decimals_));
        _balances[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view override returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= amount, "ERC20: insufficient allowance");
        _allowances[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(to != address(0), "ERC20: transfer to zero address");
        uint256 bal = _balances[from];
        require(bal >= amount, "ERC20: insufficient balance");
        _balances[from] = bal - amount;
        _balances[to] = _balances[to] + amount;
        emit Transfer(from, to, amount);
    }
}
`;
