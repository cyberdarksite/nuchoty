// ============================================================
// Shared Utility Functions for All Pages
// ============================================================

// ---------- User Management ----------
function getCurrentUser() {
    try {
        return JSON.parse(localStorage.getItem('currentUser') || '{}');
    } catch {
        return {};
    }
}

function isLoggedIn() {
    const user = getCurrentUser();
    return user.email && user.email.length > 0;
}

function requireAuth() {
    if (!isLoggedIn()) {
        window.location.href = '/login.html';
        return false;
    }
    return true;
}

function logout() {
    localStorage.removeItem('currentUser');
    window.location.href = '/login.html';
}

// ---------- Formatting ----------
function formatCurrency(amount, currency = 'KSH') {
    // Use KSH (Kenyan Shilling) as default
    return `${currency} ${Number(amount).toLocaleString()}`;
}

// Alias for quick usage
function formatKSH(amount) {
    return formatCurrency(amount, 'KSH');
}

// ---------- Toast Notifications ----------
function showToast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 12px 24px;
        border-radius: 12px;
        color: white;
        font-weight: 500;
        z-index: 9999;
        animation: slideIn 0.3s ease;
        background: ${type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#6366f1'};
        box-shadow: 0 8px 30px rgba(0,0,0,0.3);
        max-width: 90%;
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(100px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Add toast animations
(function injectToastStyles() {
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from { opacity: 0; transform: translateY(100px); }
            to { opacity: 1; transform: translateY(0); }
        }
    `;
    document.head.appendChild(style);
})();

// ---------- API Wrapper ----------
async function apiRequest(endpoint, options = {}) {
    try {
        const response = await fetch(endpoint, {
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            },
            ...options
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || data.details || 'Request failed');
        }

        return data;
    } catch (error) {
        console.error('API Error:', error);
        throw error;
    }
}

// ---------- Deployment Helpers ----------
async function fetchDeploymentLogs(deploymentId) {
    try {
        const data = await apiRequest(`/api/deployment-logs/${deploymentId}`);
        return data;
    } catch (error) {
        showToast('Failed to fetch logs: ' + error.message, 'error');
        throw error;
    }
}

async function fetchUserDeployments(email) {
    try {
        const data = await apiRequest(`/api/deployments/${encodeURIComponent(email)}`);
        return data;
    } catch (error) {
        showToast('Failed to fetch deployments: ' + error.message, 'error');
        throw error;
    }
}

async function fetchWalletBalance(email) {
    try {
        const data = await apiRequest(`/api/wallet/${encodeURIComponent(email)}`);
        return data;
    } catch (error) {
        showToast('Failed to fetch wallet: ' + error.message, 'error');
        throw error;
    }
}

async function refreshWalletDisplay(email, balanceElementId = 'walletBalance') {
    try {
        const data = await fetchWalletBalance(email);
        if (data.success) {
            const el = document.getElementById(balanceElementId);
            if (el) el.textContent = formatKSH(data.walletBalance);
        }
        return data;
    } catch (error) {
        console.error('Refresh wallet error:', error);
    }
}

// ---------- Navigation Helpers ----------
function goToLogs(deploymentId) {
    window.location.href = `/logs/${deploymentId}`;
}

function goToDeploy() {
    window.location.href = '/deploy.html';
}

function goToWallet() {
    window.location.href = '/wallet.html';
}

// ---------- DOM Ready ----------
document.addEventListener('DOMContentLoaded', function() {
    // Update navbar login button text if logged in
    const navLogin = document.querySelector('.btn-login');
    if (navLogin && isLoggedIn()) {
        const user = getCurrentUser();
        navLogin.textContent = user.email.split('@')[0];
        navLogin.href = '/wallet.html';
    }
});

// ---------- Export to global scope ----------
window.getCurrentUser = getCurrentUser;
window.isLoggedIn = isLoggedIn;
window.requireAuth = requireAuth;
window.logout = logout;
window.formatCurrency = formatCurrency;
window.formatKSH = formatKSH;
window.showToast = showToast;
window.apiRequest = apiRequest;
window.fetchDeploymentLogs = fetchDeploymentLogs;
window.fetchUserDeployments = fetchUserDeployments;
window.fetchWalletBalance = fetchWalletBalance;
window.refreshWalletDisplay = refreshWalletDisplay;
window.goToLogs = goToLogs;
window.goToDeploy = goToDeploy;
window.goToWallet = goToWallet;